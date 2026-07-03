import {
  allocSlotId,
  type ErasedItemRenderer,
  type ErasedKeyFn,
  type ErasedSelector,
  keyedScopePrefix,
  keyToken,
  popListScope,
  pushKeyedScope,
  pushListScope,
  type RenderState,
  registerBinding,
  requireCurrentRenderState,
  type SlotId,
  unregisterBindingsForScope,
} from '../server/render-context.ts'
import { isReadResult, type ReadResult } from './read.ts'
import { type HtmlFragment, isHtmlFragment } from './types.ts'

export interface EachOptions<T> {
  /** Item identity. When present, list changes emit per-item insert/remove/move
   *  patches instead of a full-body re-render — inner state (focus, transitions)
   *  survives reorders. Keys must be strings (numbers are coerced) and unique
   *  within the list. Without `key`, any list change re-renders the whole body. */
  key?: (item: T) => string | number
}

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
  opts?: EachOptions<T>,
): EachResult {
  const state = requireCurrentRenderState()

  let array: T[]
  let slotId: SlotId
  let machineName: string | null = null
  let selector: ErasedSelector | null = null

  if (isReadResult(items)) {
    array = items.value as T[]
    slotId = items.slotId
    machineName = items.machineName
    selector = items.selector
  } else {
    array = [...items]
    slotId = allocSlotId(state)
  }

  const keyFn = opts?.key
  let innerHtml: string
  if (keyFn) {
    const keys = coerceKeys(array, keyFn as ErasedKeyFn, slotId)
    innerHtml = renderKeyedListBody(state, slotId, array, keys, fn)
    if (machineName && selector) {
      registerBinding(state, {
        slotId,
        machineName,
        selector,
        lastValue: array,
        kind: 'list-keyed',
        itemRenderer: fn as ErasedItemRenderer,
        keyFn: keyFn as ErasedKeyFn,
        lastKeys: keys,
      })
    }
  } else {
    innerHtml = renderListBody(state, slotId, array, fn)
    if (machineName && selector) {
      registerBinding(state, {
        slotId,
        machineName,
        selector,
        lastValue: array,
        kind: 'list',
        itemRenderer: fn as ErasedItemRenderer,
      })
    }
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

/**
 * Validate and coerce a keyed list's keys: strings pass, finite numbers are
 * coerced, anything else is an error. Duplicates are an error — two rows with
 * the same key is a data bug, not behavior to be polite about.
 */
export function coerceKeys(
  items: readonly unknown[],
  keyFn: ErasedKeyFn,
  listSlotId: SlotId,
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const raw = keyFn(items[i])
    let key: string
    if (typeof raw === 'string') key = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) key = String(raw)
    else {
      throw new Error(
        `stator: each() key for item ${i} of list ${listSlotId} must be a string or finite ` +
          `number, got ${raw === null ? 'null' : typeof raw}`,
      )
    }
    if (seen.has(key)) {
      throw new Error(
        `stator: duplicate key "${key}" in keyed each() (list ${listSlotId}) — keys must be ` +
          `unique within a list`,
      )
    }
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/** Initial render of a keyed list: items render under *key* scopes so their
 *  inner slot ids survive reordering. */
export function renderKeyedListBody<T>(
  state: RenderState,
  listSlotId: SlotId,
  items: readonly T[],
  keys: readonly string[],
  fn: (item: T, index: number) => HtmlFragment,
): string {
  unregisterBindingsForScope(state, listSlotId)
  const chunks: string[] = []
  for (let i = 0; i < items.length; i++) {
    chunks.push(renderKeyedItem(state, listSlotId, items[i] as T, i, keys[i]!, fn))
  }
  return chunks.join('')
}

/**
 * Render one keyed item under its key scope. Used for initial render and for
 * `insert` patches during recompute. The rendered HTML must be a single root
 * element — index-addressed insert/remove/move ops count the list's element
 * children, so a multi-root item would corrupt every index after it.
 */
export function renderKeyedItem<T>(
  state: RenderState,
  listSlotId: SlotId,
  item: T,
  index: number,
  key: string,
  fn: (item: T, index: number) => HtmlFragment,
): string {
  const token = keyToken(key)
  unregisterBindingsForScope(state, keyedScopePrefix(listSlotId, token))
  pushKeyedScope(state, listSlotId, token)
  let html: string
  try {
    const fragment = fn(item, index)
    if (!isHtmlFragment(fragment)) {
      throw new Error('stator: each() callback must return an html`...` result')
    }
    html = fragment.html
  } finally {
    popListScope(state)
  }
  if (!isSingleRootElement(html)) {
    throw new Error(
      `stator: keyed each() item "${key}" must render exactly one root element — ` +
        `per-item patches address list children by index, so multi-root (or bare-text) ` +
        `items would corrupt sibling indices`,
    )
  }
  return html
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/**
 * True when `html` consists of exactly one root element (plus optional
 * surrounding whitespace). A small scanner, quote- and comment-aware — not a
 * full parser; it only tracks nesting depth at the top level.
 */
export function isSingleRootElement(html: string): boolean {
  let i = 0
  let roots = 0
  let depth = 0
  const n = html.length
  while (i < n) {
    const c = html[i]!
    if (c !== '<') {
      // Bare text at the top level (other than whitespace) is not an element.
      if (depth === 0 && !/\s/.test(c)) return false
      i++
      continue
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      if (end === -1) return false
      i = end + 3
      continue
    }
    const isClosing = html[i + 1] === '/'
    // Scan to the tag's real end, skipping quoted attribute values.
    let j = i + 1
    let quote: string | null = null
    while (j < n) {
      const ch = html[j]!
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    if (j >= n) return false
    if (isClosing) {
      depth--
      if (depth < 0) return false
    } else {
      const nameMatch = html.slice(i + 1, j).match(/^([a-zA-Z][\w-]*)/)
      const tag = nameMatch ? nameMatch[1]!.toLowerCase() : ''
      const selfClosing = html[j - 1] === '/' || VOID_TAGS.has(tag)
      if (depth === 0) {
        roots++
        if (roots > 1) return false
      }
      if (!selfClosing) depth++
    }
    i = j + 1
  }
  return roots === 1 && depth === 0
}
