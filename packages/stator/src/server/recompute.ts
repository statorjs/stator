import { renderBranchBody } from '../template/conditional.ts'
import { renderListBody } from '../template/each.ts'
import { type RenderState, runInRender } from './render-context.ts'
import type { SessionRuntime } from './session-runtime.ts'

/**
 * Wire patch. Addressing is a discriminated `target` (slot positions vs.
 * element identities) and the op describes what to do at that target. The
 * two dimensions compose orthogonally — see WIRE.md for the full contract.
 *
 * Reserved future ops (not yet emitted, documented for the wire spec):
 *   - 'attr-add' / 'attr-remove' on element targets (per-class toggles)
 *   - 'insert' / 'remove' / 'move' on slot targets (keyed list diffs)
 *   - 'prop' on element targets (IDL property writes that have no attr)
 */
export type SlotTarget = { kind: 'slot'; id: string }
export type ElementTarget = { kind: 'element'; id: string }

export type Patch =
  | { target: SlotTarget; op: 'text'; value: string }
  | { target: SlotTarget; op: 'html'; value: string }
  | { target: ElementTarget; op: 'attr'; name: string; value: string }

/** A patch paired with its source slot id — the slot in the binding tree
 *  this patch came from. Used internally for scope-subsumption. The wire
 *  shape drops this field. */
type PendingPatch = { patch: Patch; sourceSlot: string }

/**
 * Walk every binding tied to `machineName`, re-evaluate its selector against
 * the current machine snapshot, and produce patches for any binding whose
 * value changed.
 *
 * Scope subsumption: when a list (`each`) or branch (`when`/`match`) body
 * is replaced via an 'html' patch, the new body's HTML already contains the
 * fresh values of every descendant binding. Any text/attr patches whose
 * source slots live inside that scope are therefore redundant and would
 * either no-op (descendant slot IDs no longer exist in the DOM) or, worse,
 * target unrelated elements once finer-grained patches arrive. The filter
 * at the bottom of this function drops them explicitly.
 */
export function recompute(
  state: RenderState,
  machineName: string,
  runtime: SessionRuntime,
): Patch[] {
  const proxy = runtime.proxyFor(machineName)
  if (!proxy) return []

  const pending: PendingPatch[] = []
  const slotIds = state.byMachine.get(machineName)
  if (!slotIds) return []

  for (const slotId of [...slotIds]) {
    const binding = state.bindings.get(slotId)
    if (!binding) continue

    const newValue = binding.selector(proxy)

    if (binding.kind === 'text') {
      if (!valuesEqual(newValue, binding.lastValue)) {
        pending.push({
          patch: {
            target: { kind: 'slot', id: slotId },
            op: 'text',
            value: stringify(newValue),
          },
          sourceSlot: slotId,
        })
        binding.lastValue = newValue
      }
    } else if (binding.kind === 'attr') {
      if (!valuesEqual(newValue, binding.lastValue)) {
        pending.push({
          patch: {
            target: { kind: 'element', id: binding.parentId },
            op: 'attr',
            name: binding.attrName,
            value: stringify(newValue),
          },
          sourceSlot: slotId,
        })
        binding.lastValue = newValue
      }
    } else if (binding.kind === 'list') {
      const newArray = newValue as readonly unknown[]
      const oldArray = binding.lastValue as readonly unknown[]
      if (!arrayShallowEqual(newArray, oldArray)) {
        const fn = binding.itemRenderer
        const newInner = runInRender(state, () => renderListBody(state, slotId, newArray, fn))
        pending.push({
          patch: {
            target: { kind: 'slot', id: slotId },
            op: 'html',
            value: newInner,
          },
          sourceSlot: slotId,
        })
        binding.lastValue = newArray
      }
    } else if (binding.kind === 'branch') {
      const newKey = binding.branchKeyFn(newValue)
      if (!Object.is(newKey, binding.lastBranchKey)) {
        const renderer = binding.branchRenderFn(newValue)
        const newInner = runInRender(state, () => renderBranchBody(state, slotId, renderer))
        pending.push({
          patch: {
            target: { kind: 'slot', id: slotId },
            op: 'html',
            value: newInner,
          },
          sourceSlot: slotId,
        })
        binding.lastBranchKey = newKey
        binding.lastValue = newValue
      }
    }
  }

  return subsumeScopes(pending)
}

/**
 * Drop any patch whose source slot is a descendant of an 'html'-op patch's
 * scope. Descendants share the prefix `<scope-slot-id>:` per our slot-id
 * scheme (see allocSlotId / pushListScope in render-context.ts).
 */
function subsumeScopes(pending: PendingPatch[]): Patch[] {
  const scopePrefixes: string[] = []
  for (const p of pending) {
    if (p.patch.op === 'html') scopePrefixes.push(`${p.sourceSlot}:`)
  }
  if (scopePrefixes.length === 0) return pending.map((p) => p.patch)

  const out: Patch[] = []
  for (const p of pending) {
    let inside = false
    for (const prefix of scopePrefixes) {
      // The html patch itself isn't a descendant of its own scope — skip
      // the exact match.
      if (`${p.sourceSlot}:` === prefix) continue
      if (p.sourceSlot.startsWith(prefix)) {
        inside = true
        break
      }
    }
    if (!inside) out.push(p.patch)
  }
  return out
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function arrayShallowEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return String(v)
}
