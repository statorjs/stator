import type { AnyMachineDef, EffectInvocation, EventObject } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut } from './sse.ts'

const effectLog = scopedLogger('effect')

/**
 * Process-wide registry of IN-FLIGHT effect invocations. Two consumers:
 *   - hydration re-invoke dampening: a restore hook only re-fires a pending
 *     entry effect when its id is NOT already running in this process (normal
 *     request traffic hydrates constantly; only a post-crash hydration finds a
 *     pending marker with no live invocation),
 *   - exit-abort: leaving a state aborts its entry effect's signal, stopping
 *     wasted upstream work at the source (command-role transition effects are
 *     never aborted).
 * In-memory and non-durable by design — it dies with the process, exactly like
 * the work it tracks.
 */
interface InFlightEffect {
  controller: AbortController
  scope: string
  machineName: string
  kind: 'entry' | 'transition'
  stateKey?: string
}
const inFlight = new Map<string, InFlightEffect>()

export function isEffectInFlight(effectId: string): boolean {
  return inFlight.has(effectId)
}

/** Abort the entry effect(s) owned by (scope, machine, state) — called from the
 *  host's state-exit hook alongside timer cancellation. */
export function abortEntryEffects(scope: string, machineName: string, stateKey: string): void {
  for (const fx of inFlight.values()) {
    if (
      fx.kind === 'entry' &&
      fx.scope === scope &&
      fx.machineName === machineName &&
      fx.stateKey === stateKey
    ) {
      fx.controller.abort()
    }
  }
}

/**
 * Install the APP-plane effect scheduler on a MachineStore (injected
 * post-construction — see MachineStore.setAppEffectScheduler). App
 * completions are simpler than session ones: the actor is long-lived and
 * in-process, so the completion goes through `dispatchToApp` — atomic send,
 * persist opted-in machines, fan out. No lock involved.
 *
 * `createApp` and the dev server call this; a hand-rolled server that
 * constructs MachineStore directly should too.
 */
export function wireAppEffects(store: MachineStore): void {
  store.setAppEffectScheduler((invocation) => {
    void runAppEffect(invocation, store)
  })
}

async function runAppEffect(invocation: EffectInvocation, store: MachineStore): Promise<void> {
  const { machineName, effectId } = invocation
  const controller = new AbortController()
  inFlight.set(effectId, {
    controller,
    scope: '@app',
    machineName,
    kind: invocation.kind,
    stateKey: invocation.stateKey,
  })
  // The registry entry lives until the LOGICAL invocation settles — including
  // completion delivery — so a hydration racing the completion sees it in
  // flight and does not re-invoke.
  try {
    let completion: Awaited<ReturnType<EffectInvocation['run']>>
    try {
      completion = await invocation.run(controller.signal)
    } catch (err) {
      effectLog.error(
        { machine: machineName, effectId, err: String(err) },
        'effect threw — effects must catch and return their failure event; dropped',
      )
      return
    }
    // Settle the resident app actor's pendingEntry marker directly (persisted
    // when the machine opted in), then dispatch any completion.
    if (invocation.kind === 'entry') {
      if (store.appInstance(machineName)?.actor.settleEntry(effectId)) {
        await store.persistAppMachine(machineName)
      }
    }
    if (!completion) return
    try {
      const def = store.getDef(machineName)
      if (!def) return // graph changed under us (dev reload) — drop
      await dispatchToApp(store, def as AnyMachineDef, completion as never)
    } catch (err) {
      effectLog.error(
        { machine: machineName, effectId, err: String(err) },
        'effect completion dispatch failed',
      )
    }
  } finally {
    inFlight.delete(effectId)
  }
}

/**
 * Server-plane effect scheduling for SESSION machines.
 *
 * The session runtime queues invocations during `processEvent` (the actor's
 * `onEffect` hook); an entry point (POST /__events, API route) calls
 * `scheduleSessionEffects` after it has persisted — the effect's I/O then runs
 * with **no session lock held**. The completion event re-enters through the
 * full event path: fresh lock, fresh runtime hydrate (the triggering actor is
 * long gone — the transient-actor model working for us), process, persist,
 * fan out to live SSE connections. Non-live pages simply see the new state on
 * their next request.
 *
 * At-most-once, non-durable (1.0 contract): a crash between commit and
 * completion loses the effect; the machine stays in its pending state.
 */
export function scheduleSessionEffects(
  runtime: SessionRuntime,
  store: MachineStore,
  sessionId: string,
): void {
  for (const invocation of runtime.drainPendingEffects()) {
    void runSessionEffect(invocation, store, sessionId)
  }
}

async function runSessionEffect(
  invocation: EffectInvocation,
  store: MachineStore,
  sessionId: string,
): Promise<void> {
  const { machineName, effectId } = invocation
  const controller = new AbortController()
  inFlight.set(effectId, {
    controller,
    scope: sessionId,
    machineName,
    kind: invocation.kind,
    stateKey: invocation.stateKey,
  })
  // The registry entry lives until the LOGICAL invocation settles — including
  // completion delivery — so a hydration racing the completion (e.g. the
  // completion's own re-entry) sees it in flight and does not re-invoke.
  try {
    let completion: Awaited<ReturnType<EffectInvocation['run']>>
    try {
      completion = await invocation.run(controller.signal)
    } catch (err) {
      // Backstop only — the type contract asks effects to catch and return
      // their failure event. Never crashes the host.
      effectLog.error(
        { machine: machineName, effectId, err: String(err) },
        'effect threw — effects must catch and return their failure event; dropped',
      )
      return
    }
    // An entry effect that settled with no completion still clears its marker —
    // otherwise every later hydration would re-invoke a fire-and-forget load.
    const settles = invocation.kind === 'entry' ? effectId : undefined
    if (!completion) {
      if (settles) {
        try {
          await settleSessionEntry(store, sessionId, machineName, settles)
        } catch (err) {
          effectLog.error(
            { machine: machineName, effectId, err: String(err) },
            'entry-effect settle failed',
          )
        }
      }
      return
    }

    try {
      await reenterSessionEvent(store, sessionId, machineName, completion, { settles })
    } catch (err) {
      effectLog.error(
        { machine: machineName, effectId, err: String(err) },
        'effect completion dispatch failed',
      )
    }
  } finally {
    inFlight.delete(effectId)
  }
}

/** Clear a session machine's pendingEntry marker with no event to deliver —
 *  the null-completion settle path. Lock + hydrate + settle + persist (no TTL
 *  refresh: this is machine activity, not user activity). */
async function settleSessionEntry(
  store: MachineStore,
  sessionId: string,
  machineName: string,
  effectId: string,
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const def = store.getDef(machineName)
    if (!def) return
    if ((await store.persistence.get(sessionId, machineName)) === null) return
    const runtime = new SessionRuntime(sessionId, store)
    try {
      await runtime.loadGraph([def])
      const handle = runtime.handleFor(machineName)
      if (handle?.actor.settleEntry(effectId)) {
        await runtime.persistTouched(new Set([machineName]), { refreshTtl: false })
      }
    } finally {
      runtime.dispose()
    }
  })
}

/**
 * Re-enter an out-of-band event (an effect completion, or an `after` timeout)
 * through the full session event path: fresh lock, hydrate the machine (the
 * triggering runtime is long gone — the transient-actor model working for us),
 * process, persist (including a machine that fired an entry effect on the
 * resulting transition), fan out to live connections, and schedule any effect
 * the event chained. Shared by effect completions and state timeouts.
 */
export async function reenterSessionEvent(
  store: MachineStore,
  sessionId: string,
  machineName: string,
  event: EventObject,
  opts?: { settles?: string },
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const def = store.getDef(machineName)
    if (!def) return // machine graph changed under us (dev reload) — drop
    // Resurrection guard: a timer or completion outliving its session must not
    // birth a fresh machine (whose initial entry effect would fire and persist
    // a zombie). No snapshot ⇒ the session is gone ⇒ drop.
    if ((await store.persistence.get(sessionId, machineName)) === null) {
      effectLog.debug(
        { sid: sessionId, machine: machineName, event: event.type },
        'out-of-band event for expired session dropped',
      )
      return
    }
    const runtime = new SessionRuntime(sessionId, store)
    try {
      // loadGraph pulls reads + subscribers transitively, so emits reach
      // cross-machine listeners like any other event.
      await runtime.loadGraph([def])
      runtime.wireSubscriptions()
      const touched = runtime.processEvent(machineName, event)
      // Settle the entry-effect marker this completion belongs to (no-op if
      // the state moved on and the marker died with it).
      const settled =
        opts?.settles !== undefined &&
        (runtime.handleFor(machineName)?.actor.settleEntry(opts.settles) ?? false)
      const toPersist = new Set([...touched, ...runtime.entryFiredMachines()])
      if (settled) toPersist.add(machineName)
      // Machine activity must not extend the session's life — only real user
      // requests refresh the TTL. Without this, a self-rescheduling machine
      // keeps its own session immortal.
      await runtime.persistTouched(toPersist, { refreshTtl: false })
      await fanOut(touched, { sessionId })
      // A transition or entry effect chained off this event surfaces here.
      scheduleSessionEffects(runtime, store, sessionId)
    } finally {
      runtime.dispose()
    }
  })
}
