import type { AnyActor, AnyMachineDef, MachineDef } from '../engine/index.ts'
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
