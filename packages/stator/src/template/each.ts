import {
  allocSlotId,
  popListScope,
  pushListScope,
  type RenderState,
  registerBinding,
  requireCurrentRenderState,
  type SlotId,
  unregisterBindingsForScope,
} from '../server/render-context.ts'
import { isReadResult, type ReadResult } from './read.ts'
import { type HtmlFragment, isHtmlFragment } from './types.ts'

export interface EachResult {
  readonly __isEachResult: true
  readonly html: string
  readonly slotId: SlotId
}

export function isEachResult(v: unknown): v is EachResult {
  return (
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isEachResult === true
  )
}

export function each<T>(
  items: readonly T[] | ReadResult<readonly T[]>,
  fn: (item: T, index: number) => HtmlFragment,
): EachResult {
  const state = requireCurrentRenderState()

  let array: T[]
  let slotId: SlotId
  let machineName: string | null = null
  let selector: ((instance: any) => unknown) | null = null

  if (isReadResult(items)) {
    array = items.value as T[]
    slotId = items.slotId
    machineName = items.machineName
    selector = items.selector
  } else {
    array = [...items]
    slotId = allocSlotId(state)
  }

  const innerHtml = renderListBody(state, slotId, array, fn)

  if (machineName && selector) {
    registerBinding(state, {
      slotId,
      machineName,
      selector,
      lastValue: array,
      kind: 'list',
      itemRenderer: fn as (item: any, index: number) => HtmlFragment,
    })
  }

  // `display: contents` so the wrapper span is invisible to layout — its
  // children become layout-children of the surrounding element. Without
  // this, putting `each()` inside a CSS grid or flex container would
  // collapse all items into a single grid/flex cell. The span itself stays
  // in the DOM as the patch addressing target.
  const html = `<span data-slot="${slotId}" data-list="true" style="display:contents">${innerHtml}</span>`
  return { __isEachResult: true, html, slotId }
}

/**
 * Render the body of a list (the contents inside the list span).
 * Used both during initial render and during recompute when a list re-renders.
 *
 * The caller is responsible for ensuring no child bindings exist for this scope
 * before calling — this function clears them and creates fresh ones.
 */
export function renderListBody<T>(
  state: RenderState,
  listSlotId: SlotId,
  items: readonly T[],
  fn: (item: T, index: number) => HtmlFragment,
): string {
  unregisterBindingsForScope(state, listSlotId)

  const chunks: string[] = []
  for (let i = 0; i < items.length; i++) {
    pushListScope(state, listSlotId, i)
    try {
      const fragment = fn(items[i]!, i)
      if (!isHtmlFragment(fragment)) {
        throw new Error('stator: each() callback must return an html`...` result')
      }
      chunks.push(fragment.html)
    } finally {
      popListScope(state)
    }
  }
  return chunks.join('')
}
