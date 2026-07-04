import type { EffectInvocation } from '../engine/index.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut } from './sse.ts'

const effectLog = scopedLogger('effect')

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
  let completion: Awaited<ReturnType<EffectInvocation['run']>>
  try {
    completion = await invocation.run()
  } catch (err) {
    // Backstop only — the type contract asks effects to catch and return
    // their failure event. Never crashes the host.
    effectLog.error(
      { machine: machineName, effectId, err: String(err) },
      'effect threw — effects must catch and return their failure event; dropped',
    )
    return
  }
  if (!completion) return

  try {
    await withSessionLock(sessionId, async () => {
      const runtime = new SessionRuntime(sessionId, store)
      try {
        const def = store.getDef(machineName)
        if (!def) return // machine graph changed under us (dev reload) — drop
        // loadGraph pulls reads + subscribers transitively, so completion
        // emits reach cross-machine listeners like any other event.
        await runtime.loadGraph([def])
        runtime.wireSubscriptions()
        const touched = runtime.processEvent(machineName, completion)
        await runtime.persistTouched(touched)
        await fanOut(touched)
      } finally {
        runtime.dispose()
      }
    })
  } catch (err) {
    effectLog.error(
      { machine: machineName, effectId, err: String(err) },
      'effect completion dispatch failed',
    )
  }
}
