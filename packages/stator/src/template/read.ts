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
): ReadResult<TResult> {
  const state = requireCurrentRenderState()
  const def = defForProxy(instance as unknown as object)
  if (!def) {
    throw new Error(
      'stator: read() must be called with a machine instance produced by the framework',
    )
  }
  const slotId = allocSlotId(state)
  const value = selector(instance)
  return {
    __isReadResult: true,
    slotId,
    machineName: def.name,
    selector: selector as ErasedSelector,
    instance,
    value: value as TResult,
  }
}
