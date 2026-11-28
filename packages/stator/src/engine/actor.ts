import type {
  ActionHelpers,
  EffectInvocation,
  EventObject,
  GuardHelpers,
  MachineDef,
  Refusal,
  RefusalIssue,
  Snapshot,
  TransitionConfig,
} from './types.ts'

/** What one `send` did. */
export interface SendResult {
  /** A transition matched and fired. */
  committed: boolean
  /** Present only when `committed` is false and a guard said why
   *  (`helpers.refuse`). With several candidates, the first refusal recorded. */
  refusal?: Refusal
}

/** The actor surface the rest of the framework consumes. Designed to the
 *  framework's actual needs — not XState's actor protocol. */
export interface Actor<C, E extends EventObject> {
  start(): Actor<C, E>
  stop(): void
  /** Deliver an event. The result says whether a transition fired, and, when
   *  none did, why a guard refused (if one called `refuse`). */
  send(event: E): SendResult
  /** Merge into the initial context before `start()`, and optionally pick the
   *  state to start in instead of `initial` (entered for real on `start()`:
   *  entry effect, `after` timers). Used for the deferred client seed
   *  (attribute values aren't available at actor creation — only at the
   *  element's connect) and by the server host for a def's `seed` on a fresh
   *  start. No-op after start; an unknown state throws. */
  seed(partial: Partial<C>, state?: string): void
  getSnapshot(): Snapshot<C>
  /** Monotonic count of HANDLED events (a matching transition fired).
   *  Guard-dropped and unhandled events don't count — this is how the server
   *  distinguishes "committed" from "silently dropped". */
  getCommitCount(): number
  subscribe(listener: (snapshot: Snapshot<C>) => void): { unsubscribe(): void }
  /** Listen for a declared emit. Returns a remover. Used by cross-machine
   *  subscription wiring. */
  on(
    emitName: string,
    listener: (event: { type: string; [k: string]: unknown }) => void,
  ): () => void
  /** Compact snapshot for the Store / client hydration seed. */
  getPersistedSnapshot(): Snapshot<C>
  /** Host acknowledgment that the entry effect `effectId` SETTLED (completion
   *  delivered or null-resolved): clears the snapshot's pendingEntry marker so
   *  hydration stops re-invoking it. No-op on mismatch (the state moved on and
   *  the marker already belongs to a different invocation). Returns whether a
   *  marker was cleared — the host persists when true. */
  settleEntry(effectId: string): boolean
}

/** The "top type" for an actor — same variance argument as `AnyMachineDef`:
 *  `C` appears in both co- and contravariant positions, so only `any` admits
 *  every concrete actor. */
// biome-ignore lint/suspicious/noExplicitAny: existential slots (see doc comment)
export type AnyActor = Actor<any, any>

/** The shape delivered to `Actor.on` emit listeners. */
export type EmittedEvent = { type: string; [k: string]: unknown }

export interface CreateActorOptions<C> {
  /** Hydrate from a persisted snapshot (Store) or a client seed. */
  snapshot?: Snapshot<C>
  /** Host-provided resolver for the action/guard/selector `peers` helper. The
   *  server wires this to the active dispatch context; the client omits it (a
   *  peer-free machine never dereferences it). This injection is what keeps
   *  the engine isomorphic — it imports no server-only module. The map may be
   *  returned under `peers` or under its old name `reads`; the actor hands the
   *  same map to the machine under both keys, so a stub written with either
   *  name works with a machine that uses the other. */
  resolveHelpers?: () => ResolvedHelpers
  /** Host-provided effect scheduler. When set, the actor hands each pending
   *  effect to the host instead of running it (the server queues effects and
   *  runs them after the session lock releases, dispatching completions
   *  through the full event path). When omitted, the actor schedules the
   *  effect locally on a microtask and sends its completion event to itself —
   *  the client-plane (and unit-test) behavior. */
  onEffect?: (invocation: EffectInvocation) => void
  /** Host hook: a state was ENTERED (fresh start or a value-changing transition —
   *  never hydration). The server uses it to arm `after` timers from the state's
   *  config; `ctx` is the current context (for context-dependent delays). */
  onStateEnter?: (stateKey: string, ctx: C) => void
  /** Host hook: a state was LEFT (a value-changing transition). The server uses
   *  it to cancel that state's `after` timers and abort its entry effect. */
  onStateExit?: (stateKey: string) => void
  /** Host hook: a HYDRATED actor started — the state was restored, not entered.
   *  The server uses it to re-arm `after` timers with elapsed credit
   *  (`enteredAt`) and, when `pendingEntry` reports an unsettled entry effect,
   *  to re-invoke it via `refireEntry` (same effectId — idempotency keys hold
   *  across the retry). `pendingEntry` is only reported when the restored state
   *  still declares an entry effect. */
  onStateRestore?: (
    stateKey: string,
    ctx: C,
    info: { enteredAt?: number; pendingEntry?: { effectId: string }; refireEntry: () => void },
  ) => void
}

/** What a host's `resolveHelpers` returns: the peers map under `peers`, or
 *  under its old name `reads` (deprecated; removed in 4.0). */
export type ResolvedHelpers =
  | { peers: Record<string, unknown>; reads?: Record<string, unknown> }
  | { reads: Record<string, unknown>; peers?: Record<string, unknown> }

/** Put one peers map under both keys. */
function mirrorHelpers(resolved: ResolvedHelpers): ActionHelpers {
  const map = resolved.peers ?? resolved.reads ?? {}
  return { peers: map, reads: map }
}

/** Look `key` up in an author-supplied map by OWN property only. Event types
 *  and state names can come from outside the machine (a dispatched event, a
 *  persisted snapshot, a seed), and plain indexing would find
 *  `Object.prototype` members: `on['toString']` is a function, `on['__proto__']`
 *  an object, and either would be taken for a declared handler. */
function own<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

/** Unique per-invocation effect id — usable as an idempotency key, so it must
 *  be unique across process restarts (randomUUID, not a counter). */
function newEffectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Helpers that throw on any `peers` access — used when no resolver is wired
 *  (e.g. a client actor, or a direct unit-test send). A machine that ignores
 *  peers keeps working; one that dereferences them gets a clear error. One
 *  proxy serves both keys. */
function throwingHelpers(machineName: string): ActionHelpers {
  const peers = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      throw new Error(
        `stator: "${machineName}" accessed peers.${String(prop)} (helpers.peers, or its old ` +
          `name helpers.reads) with no peers resolver — actions/guards that use peers must ` +
          `run through the server dispatch path.`,
      )
    },
  })
  return { peers, reads: peers }
}

export function createActor<C extends object, E extends EventObject, S extends string>(
  def: MachineDef<C, E, S>,
  opts: CreateActorOptions<C> = {},
): Actor<C, E> {
  let value: string[] = opts.snapshot ? [...opts.snapshot.value] : [def.initial]
  let context: C = opts.snapshot
    ? (structuredClone(opts.snapshot.context) as C)
    : (structuredClone(def.context) as C)
  // Hydrated actors have already lived: their current state's entry effect fired
  // when it was entered, so `start()` must NOT blanket-re-fire it — the host
  // decides via `onStateRestore` (re-invoke only while `pendingEntry` reports
  // an unsettled completion). Fresh actors enter their initial state for real.
  const hydrated = opts.snapshot !== undefined
  let enteredAt: number | undefined = opts.snapshot?.enteredAt
  let pendingEntry: { effectId: string } | undefined = opts.snapshot?.pendingEntry

  const subscribers = new Set<(s: Snapshot<C>) => void>()
  const emitListeners = new Map<string, Set<(e: EmittedEvent) => void>>()
  let started = false

  const helpers = (): ActionHelpers => {
    const resolved = opts.resolveHelpers?.()
    return resolved ? mirrorHelpers(resolved) : throwingHelpers(def.name)
  }

  let commits = 0

  const snapshot = (): Snapshot<C> => ({
    value: [...value],
    context,
    ...(enteredAt !== undefined ? { enteredAt } : {}),
    ...(pendingEntry !== undefined ? { pendingEntry } : {}),
  })

  const notify = (): void => {
    const snap = snapshot()
    for (const fn of subscribers) fn(snap)
  }

  // Schedule a state's entry effect (if declared) — the same host-scheduled,
  // commit-time-snapshot, at-most-once path as a transition effect, minus the
  // event. Firing does NOT bump `commits` (an entry is not a committed
  // transition); the server persists an entry-firing machine via the host's
  // pending-effects queue instead (see server/session-runtime.ts).
  const fireEntryEffect = (stateKey: string, reuseEffectId?: string): void => {
    const entry = own(def.states, stateKey)?.entry
    if (!entry) return
    // A re-invocation keeps its logical id, so idempotency keys threaded to
    // external calls hold across the retry.
    const effectId = reuseEffectId ?? newEffectId()
    pendingEntry = { effectId }
    const ctxSnapshot = structuredClone(context)
    const invocation: EffectInvocation = {
      machineName: def.name,
      effectId,
      kind: 'entry',
      stateKey,
      run: (signal, session) =>
        Promise.resolve(entry(ctxSnapshot, { effectId, signal, ...(session ? { session } : {}) })),
    }
    if (opts.onEffect) {
      opts.onEffect(invocation)
    } else {
      void invocation
        .run()
        .then((completion) => {
          actor.settleEntry(effectId)
          if (completion) actor.send(completion as E)
        })
        .catch((err) => {
          console.error(
            `stator: entry effect ${effectId} of "${def.name}" threw — effects must catch ` +
              `and return their failure event. Dropped.`,
            err,
          )
        })
    }
  }

  const actor: Actor<C, E> = {
    seed(partial: Partial<C>, state?: string) {
      if (started) return
      context = { ...context, ...partial }
      if (state !== undefined) {
        if (!Object.hasOwn(def.states, state)) {
          throw new Error(
            `stator: "${def.name}" was seeded into state "${state}", which the machine does not have`,
          )
        }
        value = [state]
      }
    },
    start() {
      if (!started) {
        started = true
        notify() // let subscribe-before-start consumers sync initial state
        const current = value[value.length - 1]!
        if (!hydrated) {
          // Fresh initial-state entry.
          enteredAt = Date.now()
          fireEntryEffect(current)
          opts.onStateEnter?.(current, context)
        } else if (opts.onStateRestore) {
          // Restored, not entered: hand the host what it needs to re-arm
          // timers (elapsed credit) and recover an unsettled entry effect.
          const pending = pendingEntry && own(def.states, current)?.entry ? pendingEntry : undefined
          opts.onStateRestore(current, context, {
            enteredAt,
            pendingEntry: pending,
            refireEntry: () => {
              if (pending) fireEntryEffect(current, pending.effectId)
            },
          })
        }
      }
      return actor
    },

    stop() {
      started = false
      subscribers.clear()
      emitListeners.clear()
    },

    send(event: E): SendResult {
      // Resolve the current leaf state (depth-1 today: value[0]).
      const stateKey = value[value.length - 1]!
      const node = own(def.states, stateKey)
      // The `on` map narrows the event per key; internally we treat every
      // transition uniformly against the full event union (the runtime event
      // IS the narrowed type for this key, so the coercion is sound).
      type RawTransition = ((ctx: C, ev: E, h: ActionHelpers) => void) | TransitionConfig<C, E, S>
      // Own properties only (see `own`): an event named `toString` or
      // `constructor` is handled only where the machine declares it.
      type RawEntry = RawTransition | RawTransition[] | undefined
      const stateOn = node?.on as Record<string, RawEntry> | undefined
      let entry = own(stateOn, event.type)
      // Machine-level fallback: consulted ONLY when the current state does not
      // declare this event (state-scoped handlers win — most specific). This is
      // how a completion is handled regardless of the machine-wide state (a save
      // completing while the machine reloads) without duplicating the handler
      // into every state. A state that declares the event owns it, even if its
      // guard drops — no fall-through to machine level in that case.
      if (entry === undefined) {
        entry = own(def.on as Record<string, RawEntry> | undefined, event.type)
      }
      // An event the current state does not handle is refused with no reason:
      // the framework invents no codes.
      if (!entry) return { committed: false }

      const h = helpers()

      // One recorder per send. Guards get `refuse` on top of the action
      // helpers; the first refusal recorded is kept, later ones only refuse.
      let refusal: Refusal | undefined
      const gh: GuardHelpers = {
        ...h,
        refuse(code: string, detail?: { message?: string; issues?: RefusalIssue[] }): false {
          if (refusal === undefined) {
            refusal = {
              code,
              ...(detail?.message !== undefined ? { message: detail.message } : {}),
              ...(detail?.issues !== undefined ? { issues: detail.issues } : {}),
            }
          }
          return false
        },
      }

      // Resolve to the first candidate whose guard passes. A bare function or
      // a config with no `when` always matches.
      const candidates = Array.isArray(entry) ? entry : [entry]
      let config: TransitionConfig<C, E, S> | undefined
      for (const candidate of candidates) {
        const c: TransitionConfig<C, E, S> =
          typeof candidate === 'function' ? { do: candidate } : candidate
        if (!c.when || c.when(context, event as never, gh)) {
          config = c
          break
        }
      }
      // A reason reaches the caller only when every candidate refused; a
      // candidate that passes drops whatever an earlier one recorded.
      if (!config) return refusal ? { committed: false, refusal } : { committed: false }

      commits += 1 // a transition matched and fired — the event was HANDLED

      if (config.do) {
        const draft = structuredClone(context) as C
        config.do(draft, event as never, h)
        context = draft
      }

      if (config.to) value = [config.to]

      // Emits fire after the action commits, so payload selectors see
      // post-mutation context.
      if (config.emit) {
        const names = Array.isArray(config.emit) ? config.emit : [config.emit]
        for (const name of names) {
          const decl = own(def.emits, name)
          const payload = decl?.payload ? decl.payload(context, event as never) : {}
          const emitted = { type: name, ...payload }
          const listeners = emitListeners.get(name)
          if (listeners) for (const fn of listeners) fn(emitted)
        }
      }

      // Effects surface after commit with commit-time snapshots (same clone
      // discipline as actions). The engine never awaits them — the host
      // schedules (server), or the local default runs on a microtask (client,
      // unit tests) and sends the completion back to this actor.
      if (config.effect) {
        const effect = config.effect
        const effectId = newEffectId()
        const ctxSnapshot = structuredClone(context)
        const evSnapshot = structuredClone(event)
        const invocation: EffectInvocation = {
          machineName: def.name,
          effectId,
          kind: 'transition',
          run: (signal, session) =>
            Promise.resolve(
              effect(ctxSnapshot, evSnapshot as never, {
                effectId,
                signal,
                ...(session ? { session } : {}),
              }),
            ),
        }
        if (opts.onEffect) {
          opts.onEffect(invocation)
        } else {
          void invocation
            .run()
            .then((completion) => {
              if (completion) actor.send(completion as E)
            })
            .catch((err) => {
              console.error(
                `stator: effect ${effectId} of "${def.name}" threw — effects must catch and ` +
                  `return their failure event. Dropped.`,
                err,
              )
            })
        }
      }

      // A value-changing transition leaves the old state and enters the new one:
      // fire the new state's entry effect and let the host arm/cancel `after`
      // timers (self-transitions and action-only transitions do neither).
      if (config.to && config.to !== stateKey) {
        opts.onStateExit?.(stateKey)
        enteredAt = Date.now()
        pendingEntry = undefined // the old state's marker dies with it
        fireEntryEffect(config.to)
        opts.onStateEnter?.(config.to, context)
      }

      notify()
      return { committed: true }
    },

    getSnapshot: snapshot,
    getPersistedSnapshot: snapshot,
    getCommitCount: () => commits,

    settleEntry(effectId: string) {
      if (pendingEntry?.effectId !== effectId) return false
      pendingEntry = undefined
      return true
    },

    subscribe(listener) {
      subscribers.add(listener)
      return {
        unsubscribe() {
          subscribers.delete(listener)
        },
      }
    },

    on(emitName, listener) {
      const set = emitListeners.get(emitName) ?? new Set<(e: EmittedEvent) => void>()
      emitListeners.set(emitName, set)
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
  }

  return actor
}
