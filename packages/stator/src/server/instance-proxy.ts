import type { Actor, MachineDef } from '../engine/index.ts'
import {
  getCurrentRenderState,
  createEventDescriptor,
  type EventDescriptor,
} from './render-context.ts'
import type { InstanceOf } from '../template/types.ts'

export interface InstanceHandle<TDef extends MachineDef = MachineDef> {
  readonly def: TDef
  readonly actor: Actor<any, any>
  readonly proxy: InstanceOf<TDef>
}

const proxyToDef = new WeakMap<object, MachineDef<any, any>>()

export function defForProxy(proxy: object): MachineDef<any, any> | undefined {
  return proxyToDef.get(proxy)
}

export function createInstanceProxy<TDef extends MachineDef>(
  def: TDef,
  actor: Actor<any, any>,
): InstanceHandle<TDef> {
  const proxy = Object.create(null) as Record<string, unknown>

  for (const [name, selector] of Object.entries(def.selectors)) {
    Object.defineProperty(proxy, name, {
      enumerable: true,
      configurable: false,
      get: () => selector(actor.getSnapshot().context),
    })
  }

  Object.defineProperty(proxy, 'send', {
    enumerable: false,
    configurable: false,
    value: (event: { type: string; [k: string]: unknown }): EventDescriptor | void => {
      if (getCurrentRenderState()) {
        return createEventDescriptor(def.name, event)
      }
      actor.send(event as never)
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
