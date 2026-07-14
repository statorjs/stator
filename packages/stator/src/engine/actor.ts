import type {
  ActionHelpers,
  EffectInvocation,
  EventObject,
  MachineDef,
  Snapshot,
  TransitionConfig,
} from './types.ts'

/** The actor surface the rest of the framework consumes. Designed to the
 *  framework's actual needs — not XState's actor protocol. */
export interface Actor<C, E extends EventObject> {
  start(): Actor<C, E>
  stop(): void
  send(event: E): void
  /** Merge into the initial context before `start()`. Used for the deferred
   *  client seed (attribute values aren't available at actor creation — only at
   *  the element's connect). No-op after start. */
  seed(partial: Partial<C>): void
  getSnapshot(): Snapshot<C>
  /** Monotonic count of HANDLED events (a matching transition fired or an
   *  `@set` applied). Guard-dropped and unhandled events don't count — this
   *  is how the server distinguishes "committed" from "silently dropped". */
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
  /** Host-provided resolver for action/guard `reads` helpers. The server wires
   *  this to the active dispatch context; the client omits it (a reads-free
   *  machine never dereferences it). This injection is what keeps the engine
   *  isomorphic — it imports no server-only module. */
  resolveHelpers?: () => ActionHelpers
  /** Host-provided effect scheduler. When set, the actor hands each pending
   *  effect to the host instead of running it (the server queues effects and
   *  runs them after the session lock releases, dispatching completions
   *  through the full event path). When omitted, the actor schedules the
   *  effect locally on a microtask and sends its completion event to itself —
   *  the client-plane (and unit-test) behavior. */
  onEffect?: (invocation: EffectInvocation) => void
  /** Honor framework-internal events (currently `@set`, which powers two-way
   *  `bind:value`). Enabled ONLY for client-island actors, whose `@set` events
   *  originate from their own compiled bind code. Server actors leave this off:
   *  they take events straight from the untrusted wire (`/__events`), where a
   *  `@set` would be an arbitrary-context-write that bypasses every guard. */
  internalEvents?: boolean
}

/** Unique per-invocation effect id — usable as an idempotency key, so it must
 *  be unique across process restarts (randomUUID, not a counter). */
function newEffectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Helpers that throw on any `reads` access — used when no resolver is wired
 *  (e.g. a client actor, or a direct unit-test send). A machine that ignores
 *  reads keeps working; one that dereferences them gets a clear error. */
function throwingHelpers(machineName: string): ActionHelpers {
  return {
    reads: new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        throw new Error(
          `stator: "${machineName}" accessed reads.${String(prop)} with no reads resolver — ` +
            `actions/guards that use reads must run through the server dispatch path.`,
        )
      },
    }),
  }
}

export function createActor<C extends object, E extends EventObject, S extends string>(
  def: MachineDef<C, E, S>,
  opts: CreateActorOptions<C> = {},
): Actor<C, E> {
  let value: string[] = opts.snapshot ? [...opts.snapshot.value] : [def.initial]
  let context: C = opts.snapshot
    ? (structuredClone(opts.snapshot.context) as C)
    : (structuredClone(def.context) as C)

  const subscribers = new Set<(s: Snapshot<C>) => void>()
  const emitListeners = new Map<string, Set<(e: EmittedEvent) => void>>()
  let started = false

  const helpers = (): ActionHelpers => opts.resolveHelpers?.() ?? throwingHelpers(def.name)

  let commits = 0

  const snapshot = (): Snapshot<C> => ({ value: [...value], context })

  const notify = (): void => {
    const snap = snapshot()
    for (const fn of subscribers) fn(snap)
  }

  const actor: Actor<C, E> = {
    seed(partial: Partial<C>) {
      if (!started) context = { ...context, ...partial }
    },
    start() {
      if (!started) {
        started = true
        notify() // let subscribe-before-start consumers sync initial state
      }
      return actor
    },

    stop() {
      started = false
      subscribers.clear()
      emitListeners.clear()
    },

    send(event: E) {
      // Framework-internal `@set`: assign one context key. Powers two-way
      // `bind:value` (DOM → state) on client islands without a per-field
      // transition. Honored ONLY when the host opted in (`internalEvents`) —
      // server actors never do, so a wire-delivered `@set` falls through to
      // ordinary (unhandled) resolution and mutates nothing. Without this gate
      // `@set` is a guard-bypassing arbitrary-context write over `/__events`.
      if (opts.internalEvents && (event as { type: string }).type === '@set') {
        const e = event as unknown as { key: string; value: unknown }
        context = { ...context, [e.key]: e.value }
        commits += 1
        notify()
        return
      }
      // Resolve the current leaf state (depth-1 today: value[0]).
      const stateKey = value[value.length - 1]!
      const node = def.states[stateKey]
      // The `on` map narrows the event per key; internally we treat every
      // transition uniformly against the full event union (the runtime event
      // IS the narrowed type for this key, so the coercion is sound).
      type RawTransition = ((ctx: C, ev: E, h: ActionHelpers) => void) | TransitionConfig<C, E, S>
      const entry = node?.on?.[event.type as E['type']] as
        | RawTransition
        | RawTransition[]
        | undefined
      if (!entry) return

      const h = helpers()

      // Resolve to the first candidate whose guard passes. A bare function or
      // a config with no `when` always matches.
      const candidates = Array.isArray(entry) ? entry : [entry]
      let config: TransitionConfig<C, E, S> | undefined
      for (const candidate of candidates) {
        const c: TransitionConfig<C, E, S> =
          typeof candidate === 'function' ? { do: candidate } : candidate
        if (!c.when || c.when(context, event as never, h)) {
          config = c
          break
        }
      }
      if (!config) return

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
          const decl = def.emits[name]
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
          run: () => Promise.resolve(effect(ctxSnapshot, evSnapshot as never, { effectId })),
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

      notify()
    },

    getSnapshot: snapshot,
    getPersistedSnapshot: snapshot,
    getCommitCount: () => commits,

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
