import {
  requireCurrentRenderState,
  allocSlotId,
  pushListScope,
  popListScope,
  registerBinding,
  unregisterBindingsForScope,
  type RenderState,
  type SlotId,
} from '../server/render-context.ts'
import { isReadResult, type ReadResult } from './read.ts'
import { isHtmlFragment, type HtmlFragment } from './types.ts'

/**
 * A conditional fragment. Same wire shape as EachResult — a position-marker
 * span whose innerHTML is swapped on key change. When inactive, the span has
 * no inner content, so the conditional body's DOM is genuinely absent (not
 * hidden via CSS).
 */
export interface BranchResult {
  readonly __isBranchResult: true
  readonly html: string
  readonly slotId: SlotId
}

export function isBranchResult(v: unknown): v is BranchResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isBranchResult === true
  )
}

/**
 * Render the body for a branch result. Mirrors renderListBody: clears any
 * existing descendant bindings under this slot, pushes a child scope, and
 * runs the renderer. Returns the inner HTML (empty when renderer is null).
 */
export function renderBranchBody(
  state: RenderState,
  slotId: SlotId,
  renderer: (() => HtmlFragment) | null,
): string {
  unregisterBindingsForScope(state, slotId)
  if (!renderer) return ''
  pushListScope(state, slotId, 0)
  try {
    const fragment = renderer()
    if (!isHtmlFragment(fragment)) {
      throw new Error('stator: when()/match() renderer must return an html`...` result')
    }
    return fragment.html
  } finally {
    popListScope(state)
  }
}

/**
 * Render `fn()` when `cond` is truthy; otherwise render nothing. Re-renders
 * only when the truthiness of `cond` flips — toggling between two truthy
 * values does not cause a swap.
 */
export function when<T>(
  cond: T | ReadResult<T>,
  fn: () => HtmlFragment,
): BranchResult {
  const state = requireCurrentRenderState()

  let value: T
  let slotId: SlotId
  let machineName: string | null = null
  let selector: ((instance: any) => unknown) | null = null

  if (isReadResult(cond)) {
    value = cond.value as T
    slotId = cond.slotId
    machineName = cond.machineName
    selector = cond.selector
  } else {
    value = cond
    slotId = allocSlotId(state)
  }

  const keyFn = (v: unknown): boolean => !!v
  const renderFn = (v: unknown): (() => HtmlFragment) | null => (v ? fn : null)

  const activeKey = keyFn(value)
  const innerHtml = renderBranchBody(state, slotId, renderFn(value))

  if (machineName && selector) {
    registerBinding(state, {
      slotId,
      machineName,
      selector,
      lastValue: value,
      kind: 'branch',
      branchKeyFn: keyFn,
      branchRenderFn: renderFn,
      lastBranchKey: activeKey,
    })
  }

  const html = `<span data-slot="${slotId}" data-branch="true">${innerHtml}</span>`
  return { __isBranchResult: true, html, slotId }
}

/**
 * Render the body for the matching case key, or nothing if no case matches.
 * Re-renders only when the key changes — toggling other context fields
 * doesn't cause a swap.
 *
 * Type-safe when `key` is a `ReadResult<TKey extends string>`: cases must be
 * keyed by the same literal union.
 */
export function match<TKey extends string>(
  key: TKey | ReadResult<TKey>,
  cases: Partial<Record<TKey, () => HtmlFragment>>,
): BranchResult {
  const state = requireCurrentRenderState()

  let value: TKey
  let slotId: SlotId
  let machineName: string | null = null
  let selector: ((instance: any) => unknown) | null = null

  if (isReadResult(key)) {
    value = key.value as TKey
    slotId = key.slotId
    machineName = key.machineName
    selector = key.selector
  } else {
    value = key
    slotId = allocSlotId(state)
  }

  const keyFn = (v: unknown): unknown => v
  const renderFn = (v: unknown): (() => HtmlFragment) | null => {
    const fn = (cases as Record<string, (() => HtmlFragment) | undefined>)[String(v)]
    return fn ?? null
  }

  const innerHtml = renderBranchBody(state, slotId, renderFn(value))

  if (machineName && selector) {
    registerBinding(state, {
      slotId,
      machineName,
      selector,
      lastValue: value,
      kind: 'branch',
      branchKeyFn: keyFn,
      branchRenderFn: renderFn,
      lastBranchKey: keyFn(value),
    })
  }

  const html = `<span data-slot="${slotId}" data-branch="true">${innerHtml}</span>`
  return { __isBranchResult: true, html, slotId }
}
