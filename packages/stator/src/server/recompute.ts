import { renderBranchBody } from '../template/conditional.ts'
import { coerceKeys, renderKeyedItem, renderListBody } from '../template/each.ts'
import type { Patch } from '../wire/index.ts'
import { isUrlAttribute, safeAttrUrl } from '../wire/safe-url.ts'
import {
  type ItemBinding,
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

/** Diff one row's item-value bindings against its current item, pushing a text-
 *  or attr-op patch for each changed field — the row itself is never re-rendered.
 *  Text bindings target their slot, attr bindings their element, mirroring the
 *  machine text/attr binding patches. Only ever called for live (retained/
 *  current) rows, so no subsumption concern. */
function diffItemBindings(
  pending: PendingPatch[],
  row: ItemBinding[],
  item: unknown,
  index: number,
): void {
  for (const ib of row) {
    const nv = ib.selector(item, index)
    if (valuesEqual(nv, ib.lastValue)) continue
    ib.lastValue = nv
    if (ib.kind === 'text') {
      pending.push({
        patch: { target: { kind: 'slot', id: ib.slotId }, op: 'text', value: stringify(nv) },
        sourceSlot: ib.slotId,
      })
    } else {
      pending.push({
        patch: {
          target: { kind: 'element', id: ib.parentId },
          op: 'attr',
          name: ib.attrName,
          value: sanitizeAttrWire(ib.attrName, attrWireValue(nv)),
        },
        sourceSlot: ib.parentId,
      })
    }
  }
}

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
  // Expose the fan-out runtime to nested `read()`s so an arm/list body that
  // re-renders this pass resolves the CURRENT proxy, not its frozen closure
  // instance (FINDINGS #3). Restored after so nothing leaks across passes.
  const prevRuntime = state.currentRuntime
  state.currentRuntime = runtime
  try {
    return recomputeInner(state, machineName, runtime)
  } finally {
    state.currentRuntime = prevRuntime
  }
}

function recomputeInner(state: RenderState, machineName: string, runtime: SessionRuntime): Patch[] {
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
            value: sanitizeAttrWire(binding.attrName, attrWireValue(newValue)),
          },
          sourceSlot: slotId,
        })
        binding.lastValue = newValue
      }
    } else if (binding.kind === 'list') {
      const newArray = newValue as readonly unknown[]
      const oldArray = binding.lastValue as readonly unknown[]
      const rows = binding.rows
      // SPIKE (finding #5 / option C): a same-length list with item bindings
      // diffs each row's item-value bindings and patches only the changed fields
      // — the row DOM (islands, focus) is preserved, and identity churn (the VM
      // re-deriving item objects) no longer forces a re-render, because we
      // compare *values*, not references. Nested read() bindings inside a row
      // are separate machine bindings and update through the main pass as usual.
      if (rows && newArray.length === rows.length) {
        for (let i = 0; i < newArray.length; i++) {
          diffItemBindings(pending, rows[i]!, newArray[i], i)
        }
        binding.lastValue = newArray
      } else if (!arrayShallowEqual(newArray, oldArray)) {
        // No item bindings, or the length changed → wholesale re-render (and
        // refresh binding.rows so a later same-length pass is granular again).
        const fn = binding.itemRenderer
        const rendered = runInRender(state, () => renderListBody(state, slotId, newArray, fn))
        pending.push({
          patch: {
            target: { kind: 'slot', id: slotId },
            op: 'html',
            value: rendered.html,
          },
          sourceSlot: slotId,
        })
        binding.lastValue = newArray
        binding.rows = rendered.rows.some((r) => r.length > 0) ? rendered.rows : undefined
      }
    } else if (binding.kind === 'list-keyed') {
      // Keyed diff: shape changes become per-item insert/remove/move ops from
      // a replay simulation (`work` mirrors what the client's DOM will look
      // like after each emitted op — see the wire contract). Retained rows keep
      // their DOM; their content updates through nested read()s and — option C —
      // per-row itemBind item-value bindings (diffed after the shape pass).
      const newArray = newValue as readonly unknown[]
      const newKeys = coerceKeys(newArray, binding.keyFn, slotId)
      const oldKeys = binding.lastKeys
      const rowsByKey = binding.rowsByKey
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
          rowsByKey?.delete(key)
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
            const row = runInRender(state, () =>
              renderKeyedItem(state, slotId, newArray[i], i, key, binding.itemRenderer),
            )
            rowsByKey?.set(key, row.bindings)
            pending.push({
              patch: { target, op: 'insert', index: i, value: row.html },
              sourceSlot: slotId,
            })
            work.splice(i, 0, key)
          }
        }
        binding.lastKeys = newKeys
      }
      // Option C (keyed): retained rows re-evaluate their item-value bindings, so
      // a content change patches the changed field in place — no re-render, no
      // reliance on the row carrying a nested read(). Rows inserted this pass are
      // already current (rendered above); removed rows are gone.
      if (rowsByKey) {
        const oldKeySet = new Set(oldKeys)
        for (let i = 0; i < newKeys.length; i++) {
          const key = newKeys[i]!
          if (!oldKeySet.has(key)) continue
          const row = rowsByKey.get(key)
          if (!row) continue
          diffItemBindings(pending, row, newArray[i], i)
        }
      }
      binding.lastValue = newArray
    } else if (binding.kind === 'branch') {
      const newKey = binding.branchKeyFn(newValue)
      if (!Object.is(newKey, binding.lastBranchKey)) {
        const renderer = binding.branchRenderFn(newValue)
        const newInner = runInRender(state, () => renderBranchBody(state, slotId, newKey, renderer))
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

/** Baseline invalidation marker — never equal to any real value or key. */
const NEVER_SYNCED = Symbol('stator.never-synced')

/**
 * Initial-sync patches for a freshly opened live connection.
 *
 * The connection's diff baseline is built by re-rendering the route AT
 * CONNECT time, but the browser's DOM was rendered at page-GET time — and
 * any state change in the gap (an effect settling during navigation is the
 * classic case) would otherwise be permanently invisible: future diffs run
 * against a baseline the DOM never received. This forces every binding to
 * emit its CURRENT value once, so the DOM converges to the baseline; the
 * patches are idempotent, so an already-fresh page just repaints in place.
 *
 * Keyed lists are reset wholesale (one `html` patch of freshly rendered
 * rows) — positional insert/remove/move ops assume a known DOM row set,
 * which is exactly what a possibly-stale page can't offer.
 */
export function initialSyncPatches(state: RenderState, runtime: SessionRuntime): Patch[] {
  const patches: Patch[] = []

  // Keyed lists first: re-render every row under its key scope (replacing
  // the scope's binding registrations) and emit one wholesale reset.
  for (const [slotId, binding] of [...state.bindings]) {
    if (binding.kind !== 'list-keyed') continue
    const items = (binding.lastValue ?? []) as readonly unknown[]
    const keys = binding.lastKeys
    for (const key of keys) {
      unregisterBindingsForScope(state, keyedScopePrefix(slotId, keyToken(key)))
    }
    // Rebuild rowsByKey alongside the HTML — the re-render replaces every row's
    // slot registrations, so the old item-bindings are stale.
    const rebuilt: typeof binding.rowsByKey = binding.rowsByKey ? new Map() : undefined
    let rowsHtml = ''
    for (let i = 0; i < items.length; i++) {
      const key = keys[i]!
      const row = runInRender(state, () =>
        renderKeyedItem(state, slotId, items[i], i, key, binding.itemRenderer),
      )
      rowsHtml += row.html
      rebuilt?.set(key, row.bindings)
    }
    if (rebuilt) binding.rowsByKey = rebuilt
    patches.push({ target: { kind: 'slot', id: slotId }, op: 'html', value: rowsHtml })
  }

  // Everything else: invalidate baselines and let the normal recompute paths
  // re-emit at current values (branch bodies re-render through the same code
  // that handles real branch flips).
  for (const binding of state.bindings.values()) {
    if (binding.kind === 'text' || binding.kind === 'attr' || binding.kind === 'list') {
      binding.lastValue = NEVER_SYNCED
    } else if (binding.kind === 'branch') {
      binding.lastBranchKey = NEVER_SYNCED
    }
  }
  for (const machineName of state.byMachine.keys()) {
    patches.push(...recompute(state, machineName, runtime))
  }
  return patches
}

/** Attr-binding wire semantics, mirroring the render side: false/null/
 *  undefined → null (attribute removed), true → '' (present, empty),
 *  anything else stringified. */
function attrWireValue(v: unknown): string | null {
  if (v === false || v === null || v === undefined) return null
  if (v === true) return ''
  return stringify(v)
}

/** Mirror of html.ts `sanitizeAttrValue` for the live-update path: strip a
 *  javascript:/vbscript: value from a url-bearing attribute patch so a binding
 *  that was safe at first render can't turn dangerous via a diff. Null
 *  (attribute-absent) passes through. */
function sanitizeAttrWire(attrName: string, value: string | null): string | null {
  if (value === null) return null
  return isUrlAttribute(attrName) ? safeAttrUrl(value) : value
}
