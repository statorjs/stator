import type { AnyMachineDef } from '../server/define-machine.ts'
import { defForProxy } from '../server/instance-proxy.ts'
import {
  allocSlotId,
  type ErasedSelector,
  requireCurrentRenderState,
  type SlotId,
} from '../server/render-context.ts'
import type { InstanceOf } from './types.ts'

export interface ReadResult<T = unknown> {
  readonly __isReadResult: true
  slotId: SlotId
  machineName: string
  selector: ErasedSelector
  /** The machine proxy this read was bound against. Re-evaluating
   *  `selector(instance)` always returns fresh state because the proxy
   *  reads through `actor.getSnapshot()` on every access. */
  instance: unknown
  value: T
}

export function isReadResult(v: unknown): v is ReadResult {
  return (
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isReadResult === true
  )
}

export function read<TDef extends AnyMachineDef, TResult>(
  instance: InstanceOf<TDef>,
  selector: (instance: InstanceOf<TDef>) => TResult,
): ReadResult<TResult>
/**
 * Live field of an `each` row — `read(item, (i) => i.field)`. `read()` is the
 * one marker for live data, so an item field that changes over time is read the
 * same way a machine value is. The compiler lowers this form to a per-row
 * `itemBind`; it is valid only where `item` is the each callback's item param.
 */
export function read<TItem, TResult>(
  item: TItem,
  selector: (item: TItem) => TResult,
): ReadResult<TResult>
export function read(
  // biome-ignore lint/suspicious/noExplicitAny: overload implementation — the typed surface is the two signatures above
  instance: any,
  // biome-ignore lint/suspicious/noExplicitAny: overload implementation — see above
  selector: (instance: any) => unknown,
): ReadResult {
  const state = requireCurrentRenderState()
  const def = defForProxy(instance as unknown as object)
  if (!def) {
    // The item-read overload exists only for typing — the compiler rewrites
    // read(item, …) to itemBind before runtime, so a non-machine here is a bug.
    throw new Error(
      'stator: read() must be called with a machine instance produced by the framework',
    )
  }
  const slotId = allocSlotId(state)
  // During a recompute-driven re-render (fan-out), resolve the CURRENT proxy for
  // this machine so arm/list interiors see fresh state — the closure `instance`
  // was frozen at connect-time by `rehydrate()` (FINDINGS #3). On the initial
  // render `currentRuntime` is null and `instance` already IS the current proxy.
  const live = state.currentRuntime?.proxyFor(def.name)
  const source = live ?? instance
  const value = selector(source)
  return {
    __isReadResult: true,
    slotId,
    machineName: def.name,
    selector: selector as ErasedSelector,
    instance: source,
    value,
  }
}
