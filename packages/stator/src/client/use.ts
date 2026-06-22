import {
  createActor,
  type Actor,
  type MachineDef,
  type Snapshot,
} from '../engine/index.ts'

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
  readonly __actor: Actor<any, any>
}

const ACTOR = Symbol('stator.actor')

/** Active collector: `use()` registers its actor here during element
 *  construction, so `StatorElement` can start/stop them on connect/disconnect.
 *  A stack supports nested construction (rare, but correct). */
const collectors: Actor<any, any>[][] = []

export function pushCollector(): Actor<any, any>[] {
  const bucket: Actor<any, any>[] = []
  collectors.push(bucket)
  return bucket
}

export function popCollector(): void {
  collectors.pop()
}

/**
 * Instantiate a client machine, owned by the constructing element. Optionally
 * seed scalar values into the initial context (the narrow hydration seed —
 * e.g. a server-rendered `unit-price` attribute).
 */
export function use(def: MachineDef, seed?: Record<string, unknown>): ClientInstance {
  const snapshot: Snapshot<any> | undefined = seed
    ? { value: [def.initial], context: { ...(def.context as object), ...seed } }
    : undefined
  const actor = createActor(def as MachineDef<any, any, any>, { snapshot })

  // Register with the element under construction so its lifecycle owns the actor.
  const bucket = collectors[collectors.length - 1]
  if (bucket) bucket.push(actor)

  const inst = Object.create(null) as Record<string | symbol, unknown>
  ;(inst as any)[ACTOR] = actor

  // Selectors + context keys as live getters reading the current snapshot.
  const selectorNames = Object.keys(def.selectors)
  const contextNames = Object.keys(def.context as object)
  for (const key of new Set([...selectorNames, ...contextNames])) {
    Object.defineProperty(inst, key, {
      enumerable: true,
      get: () => {
        const ctx = actor.getSnapshot().context
        const sel = (def.selectors as Record<string, (c: any) => unknown>)[key]
        return sel ? sel(ctx) : (ctx as Record<string, unknown>)[key]
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
export function actorOf(inst: ClientInstance): Actor<any, any> {
  return (inst as any)[ACTOR]
}
