import type { Actor, AnyStateMachine } from 'xstate'
import type { MachineDef } from './define-machine.ts'
import {
  getCurrentRenderState,
  createEventDescriptor,
  type EventDescriptor,
} from './render-context.ts'
import type { InstanceOf } from '../template/types.ts'

export interface InstanceHandle<TDef extends MachineDef = MachineDef> {
  readonly def: TDef
  readonly actor: Actor<AnyStateMachine>
  readonly proxy: InstanceOf<TDef>
}

const proxyToDef = new WeakMap<object, MachineDef<any, any>>()

export function defForProxy(proxy: object): MachineDef<any, any> | undefined {
  return proxyToDef.get(proxy)
}

export function createInstanceProxy<TDef extends MachineDef>(
  def: TDef,
  actor: Actor<AnyStateMachine>,
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
    get: () => actor.getSnapshot().value,
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
