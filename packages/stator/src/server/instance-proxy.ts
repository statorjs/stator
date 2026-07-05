import type { ActionHelpers, AnyActor, AnyMachineDef, MachineDef } from '../engine/index.ts'
import type { InstanceOf } from '../template/types.ts'
import {
  createEventDescriptor,
  type EventDescriptor,
  getCurrentRenderState,
} from './render-context.ts'

export interface InstanceHandle<TDef extends MachineDef = MachineDef> {
  readonly def: TDef
  readonly actor: AnyActor
  readonly proxy: InstanceOf<TDef>
}

const proxyToDef = new WeakMap<object, AnyMachineDef>()

export function defForProxy(proxy: object): AnyMachineDef | undefined {
  return proxyToDef.get(proxy)
}

export function createInstanceProxy<TDef extends MachineDef>(
  def: TDef,
  actor: AnyActor,
  /** Resolve a sibling machine's proxy for reads-aware selectors. Lazy —
   *  called at selector-access time, so graph load order doesn't matter.
   *  Omitted (tests, contexts without a graph): reads access throws. */
  resolveRead?: (name: string) => unknown,
): InstanceHandle<TDef> {
  const proxy = Object.create(null) as Record<string, unknown>

  // Selectors receive the same helpers shape actions/guards get. The reads
  // views are the sibling proxies themselves, so a read machine's own
  // reads-aware selectors recurse naturally. (A reads-cycle between
  // selectors is an author error and shows up as a stack overflow.)
  const helpers: ActionHelpers = {
    reads: new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        const sibling = resolveRead?.(prop)
        if (sibling === undefined) {
          throw new Error(
            `stator: selector on "${def.name}" accessed reads.${prop}, but "${prop}" ` +
              `is not resolvable here — declare it in reads: and evaluate selectors ` +
              `through a runtime/store-backed instance.`,
          )
        }
        return sibling
      },
    }),
  }

  for (const [name, selector] of Object.entries(def.selectors)) {
    Object.defineProperty(proxy, name, {
      enumerable: true,
      configurable: false,
      get: () => selector(actor.getSnapshot().context, helpers),
    })
  }

  Object.defineProperty(proxy, 'send', {
    enumerable: false,
    configurable: false,
    value: (event: { type: string; [k: string]: unknown }): EventDescriptor | undefined => {
      if (getCurrentRenderState()) {
        return createEventDescriptor(def.name, event)
      }
      actor.send(event as never)
      return undefined
    },
  })

  Object.defineProperty(proxy, 'state', {
    enumerable: true,
    configurable: false,
    // Engine state value is a path array (`['idle']`); expose the leaf name as
    // a string so templates/selectors see the current state key as before.
    get: () => {
      const v = actor.getSnapshot().value
      return v[v.length - 1]
    },
  })

  Object.defineProperty(proxy, 'snapshot', {
    enumerable: true,
    configurable: false,
    get: () => actor.getSnapshot(),
  })

  proxyToDef.set(proxy, def)

  return {
    def,
    actor,
    proxy: proxy as unknown as InstanceOf<TDef>,
  }
}
