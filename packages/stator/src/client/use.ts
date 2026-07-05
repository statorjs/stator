import {
  type AnyActor,
  type AnyMachineDef,
  createActor,
  type MachineDef,
  type Snapshot,
} from '../engine/index.ts'

const CLIENT_HELPERS = {
  reads: new Proxy(
    {},
    {
      get(_t, prop: string) {
        throw new Error(`stator: client machines have no reads (accessed reads.${prop})`)
      },
    },
  ),
} as never

/**
 * The client-side reactive handle for a machine. Returned by `use()`, held as a
 * class field (`qty = use(Qty)`). Exposes:
 *   - each selector / context key as a live property (read through the actor's
 *     current snapshot on every access — the client mirror of the server
 *     instance proxy). This is what `bind:text={qty.count}` reads.
 *   - `send(event)` to drive transitions.
 *   - the underlying actor (non-enumerable) for the binding loop to subscribe.
 */
export interface ClientInstance {
  send(event: { type: string; [k: string]: unknown } | string): void
  /** @internal — the actor a binding subscribes to. */
  readonly __actor: AnyActor
}

/** An actor plus an optional deferred seed thunk — evaluated at the element's
 *  connect (when attributes are available), not at construction. */
export interface CollectedActor {
  actor: AnyActor
  seedThunk?: () => Record<string, unknown>
}

/** Active collector: `use()` registers its actor here during element
 *  construction, so `StatorElement` can start/seed/stop them on connect/disconnect.
 *  A stack supports nested construction (rare, but correct). */
const collectors: CollectedActor[][] = []

export function pushCollector(): CollectedActor[] {
  const bucket: CollectedActor[] = []
  collectors.push(bucket)
  return bucket
}

export function popCollector(): void {
  collectors.pop()
}

/**
 * Instantiate a client machine, owned by the constructing element. The optional
 * seed sets initial context (the narrow hydration seed). A plain object is
 * applied eagerly; a **thunk** `() => ({...})` is deferred to the element's
 * connect — required when the seed reads `this.attrs`, since attributes aren't
 * available at construction (the custom-element upgrade-timing rule).
 */
export function use(
  def: MachineDef,
  seed?: Record<string, unknown> | (() => Record<string, unknown>),
): ClientInstance {
  const eager = typeof seed === 'object' ? seed : undefined
  const snapshot: Snapshot<object> | undefined = eager
    ? {
        value: [def.initial],
        context: { ...(def.context as object), ...eager },
      }
    : undefined
  const actor = createActor(def as AnyMachineDef, { snapshot })

  // Register with the element under construction so its lifecycle owns the actor.
  const bucket = collectors[collectors.length - 1]
  if (bucket)
    bucket.push({
      actor,
      seedThunk: typeof seed === 'function' ? seed : undefined,
    })

  const inst = Object.create(null) as Record<string | symbol, unknown>

  // Selectors + context keys as live getters reading the current snapshot.
  const selectorNames = Object.keys(def.selectors)
  const contextNames = Object.keys(def.context as object)
  for (const key of new Set([...selectorNames, ...contextNames])) {
    Object.defineProperty(inst, key, {
      enumerable: true,
      get: () => {
        const ctx = actor.getSnapshot().context
        const sel = def.selectors[key]
        // Client machines have no cross-machine reads; pass a stub so the
        // shared SelectorMap signature holds.
        return sel ? sel(ctx, CLIENT_HELPERS) : (ctx as Record<string, unknown>)[key]
      },
    })
  }

  Object.defineProperty(inst, 'send', {
    enumerable: false,
    value: (event: { type: string; [k: string]: unknown } | string) =>
      actor.send(typeof event === 'string' ? ({ type: event } as never) : (event as never)),
  })
  Object.defineProperty(inst, '__actor', {
    enumerable: false,
    get: () => actor,
  })

  return inst as unknown as ClientInstance
}

/** Extract the actor from a `use()` instance (for the binding loop). */
export function actorOf(inst: ClientInstance): AnyActor {
  return inst.__actor
}
