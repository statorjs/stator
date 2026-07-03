import { renderBranchBody } from '../template/conditional.ts'
import { coerceKeys, renderKeyedItem, renderListBody } from '../template/each.ts'
import type { Patch } from '../wire/index.ts'
import {
  keyedScopePrefix,
  keyToken,
  type RenderState,
  runInRender,
  unregisterBindingsForScope,
} from './render-context.ts'
import type { SessionRuntime } from './session-runtime.ts'

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
  // Keyed-list scopes torn down this pass (removed rows) — any patch already
  // emitted for a slot inside one targets DOM the remove op deletes.
  const removedScopes: string[] = []
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
    } else if (binding.kind === 'list-keyed') {
      // Keyed diff: shape changes become per-item insert/remove/move ops from
      // a replay simulation (`work` mirrors what the client's DOM will look
      // like after each emitted op — see the wire contract). Content inside
      // retained items updates through the items' own nested bindings; the
      // keyed path never re-renders a retained row.
      const newArray = newValue as readonly unknown[]
      const newKeys = coerceKeys(newArray, binding.keyFn, slotId)
      const oldKeys = binding.lastKeys
      if (!stringArraysEqual(newKeys, oldKeys)) {
        const target = { kind: 'slot', id: slotId } as const
        const newKeySet = new Set(newKeys)
        const work = [...oldKeys]
        // Removals right-to-left so earlier indices stay valid within the pass.
        for (let i = work.length - 1; i >= 0; i--) {
          const key = work[i]!
          if (newKeySet.has(key)) continue
          pending.push({ patch: { target, op: 'remove', index: i }, sourceSlot: slotId })
          const scope = keyedScopePrefix(slotId, keyToken(key))
          removedScopes.push(`${scope}:`)
          unregisterBindingsForScope(state, scope)
          work.splice(i, 1)
        }
        // Settle each position left-to-right: an existing key moves up, a new
        // key renders under its key scope and inserts.
        for (let i = 0; i < newKeys.length; i++) {
          const key = newKeys[i]!
          if (work[i] === key) continue
          const from = work.indexOf(key, i + 1)
          if (from !== -1) {
            pending.push({ patch: { target, op: 'move', from, to: i }, sourceSlot: slotId })
            work.splice(from, 1)
            work.splice(i, 0, key)
          } else {
            const itemHtml = runInRender(state, () =>
              renderKeyedItem(state, slotId, newArray[i], i, key, binding.itemRenderer),
            )
            pending.push({
              patch: { target, op: 'insert', index: i, value: itemHtml },
              sourceSlot: slotId,
            })
            work.splice(i, 0, key)
          }
        }
        binding.lastKeys = newKeys
      }
      binding.lastValue = newArray
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

  return subsumeScopes(pending, removedScopes)
}

/** Positional string-array equality — the keyed diff's "did anything change". */
function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Drop any patch whose source slot is a descendant of an 'html'-op patch's
 * scope, or of a keyed-list scope removed this pass. Descendants share the
 * prefix `<scope-slot-id>:` per our slot-id scheme (see allocSlotId /
 * pushListScope / pushKeyedScope in render-context.ts).
 */
function subsumeScopes(pending: PendingPatch[], removedScopes: string[]): Patch[] {
  const scopePrefixes: string[] = [...removedScopes]
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
