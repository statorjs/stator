import type {
  ActionHelpers,
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
  getSnapshot(): Snapshot<C>
  subscribe(listener: (snapshot: Snapshot<C>) => void): { unsubscribe(): void }
  /** Listen for a declared emit. Returns a remover. Used by cross-machine
   *  subscription wiring. */
  on(emitName: string, listener: (event: { type: string; [k: string]: unknown }) => void): () => void
  /** Compact snapshot for the Store / client hydration seed. */
  getPersistedSnapshot(): Snapshot<C>
}

export interface CreateActorOptions<C> {
  /** Hydrate from a persisted snapshot (Store) or a client seed. */
  snapshot?: Snapshot<C>
  /** Host-provided resolver for action/guard `reads` helpers. The server wires
   *  this to the active dispatch context; the client omits it (a reads-free
   *  machine never dereferences it). This injection is what keeps the engine
   *  isomorphic — it imports no server-only module. */
  resolveHelpers?: () => ActionHelpers
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
  const emitListeners = new Map<string, Set<(e: any) => void>>()
  let started = false

  const helpers = (): ActionHelpers => opts.resolveHelpers?.() ?? throwingHelpers(def.name)

  const snapshot = (): Snapshot<C> => ({ value: [...value], context })

  const notify = (): void => {
    const snap = snapshot()
    for (const fn of subscribers) fn(snap)
  }

  const actor: Actor<C, E> = {
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
      // Resolve the current leaf state (depth-1 today: value[0]).
      const stateKey = value[value.length - 1]!
      const node = def.states[stateKey]
      // The `on` map narrows the event per key; internally we treat every
      // transition uniformly against the full event union (the runtime event
      // IS the narrowed type for this key, so the coercion is sound).
      const transition = node?.on?.[event.type as E['type']] as
        | ((ctx: C, ev: E, h: ActionHelpers) => void)
        | TransitionConfig<C, E, S>
        | undefined
      if (!transition) return

      const config: TransitionConfig<C, E, S> =
        typeof transition === 'function' ? { do: transition } : transition

      const h = helpers()

      if (config.when && !config.when(context, event as never, h)) return

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

      notify()
    },

    getSnapshot: snapshot,
    getPersistedSnapshot: snapshot,

    subscribe(listener) {
      subscribers.add(listener)
      return {
        unsubscribe() {
          subscribers.delete(listener)
        },
      }
    },

    on(emitName, listener) {
      let set = emitListeners.get(emitName)
      if (!set) {
        set = new Set()
        emitListeners.set(emitName, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
      }
    },
  }

  return actor
}
