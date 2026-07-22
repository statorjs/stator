import {
  allocSlotId,
  type ErasedItemRenderer,
  type ErasedKeyFn,
  type ErasedSelector,
  type ItemBinding,
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

/**
 * SPIKE (finding #5 / option C): the value of an item-dependent interpolation
 * inside an `each` row — what the compiler will lower `{item.field}` to. It
 * evaluates the selector against the *current* row's item now, and registers a
 * per-row binding so a later content change patches this one slot in place
 * (rather than re-rendering the row, so islands/focus survive).
 */
export interface ItemReadResult {
  readonly __isItemRead: true
  readonly selector: (item: unknown, index: number) => unknown
  readonly value: unknown
}

export function isItemReadResult(v: unknown): v is ItemReadResult {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isItemRead === true
}

// biome-ignore lint/suspicious/noExplicitAny: erased item selector — the item type is the each callback's, recovered at the call site
export function itemBind(selector: (item: any, index: number) => unknown): ItemReadResult {
  const state = requireCurrentRenderState()
  if (!state.currentRowBindings) {
    throw new Error(
      'stator: read(item, …) (itemBind) called outside an each() row render — an item ' +
        'binding is owned by its row, which supplies the item and re-diffs the binding. ' +
        'This happens when an item read sits inside a when()/match()/defer() arm (an arm ' +
        're-renders on its own schedule, without the row) or outside each() entirely. ' +
        'Use a machine read there instead.',
    )
  }
  // Compute the value now (for initial render); the per-row binding is registered
  // by html.ts, which knows the position (text span vs attribute) — same split as
  // read() → handleRead.
  const value = selector(state.currentItem, state.currentItemIndex ?? 0)
  return { __isItemRead: true, selector, value }
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
    const body = renderKeyedListBody(state, slotId, array, keys, fn)
    innerHtml = body.html
    if (machineName && selector) {
      const hasItemBindings = [...body.rowsByKey.values()].some((b) => b.length > 0)
      registerBinding(state, {
        slotId,
        machineName,
        selector,
        lastValue: array,
        kind: 'list-keyed',
        itemRenderer: fn as ErasedItemRenderer,
        keyFn: keyFn as ErasedKeyFn,
        lastKeys: keys,
        // Same opt-in as non-keyed: only track rows when there ARE item bindings.
        rowsByKey: hasItemBindings ? body.rowsByKey : undefined,
      })
    }
  } else {
    const body = renderListBody(state, slotId, array, fn)
    innerHtml = body.html
    if (machineName && selector) {
      registerBinding(state, {
        slotId,
        machineName,
        selector,
        lastValue: array,
        kind: 'list',
        itemRenderer: fn as ErasedItemRenderer,
        // Only opt into the granular path when there ARE item bindings —
        // otherwise (static-capture rows) leave it undefined so recompute
        // wholesale-re-renders as before, keeping content fresh.
        rows: body.rows.some((r) => r.length > 0) ? body.rows : undefined,
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
): { html: string; rows: ItemBinding[][] } {
  unregisterBindingsForScope(state, listSlotId)

  // Save/restore the ambient row context around the whole body so a nested
  // each() (a row rendering its own list) doesn't clobber this list's row.
  const prevItem = state.currentItem
  const prevIndex = state.currentItemIndex
  const prevRow = state.currentRowBindings

  const chunks: string[] = []
  const rows: ItemBinding[][] = []
  for (let i = 0; i < items.length; i++) {
    pushListScope(state, listSlotId, i)
    const rowBindings: ItemBinding[] = []
    state.currentItem = items[i]
    state.currentItemIndex = i
    state.currentRowBindings = rowBindings
    try {
      const fragment = fn(items[i]!, i)
      if (!isHtmlFragment(fragment)) {
        throw new Error('stator: each() callback must return an html`...` result')
      }
      chunks.push(fragment.html)
      rows.push(rowBindings)
    } finally {
      popListScope(state)
    }
  }

  state.currentItem = prevItem
  state.currentItemIndex = prevIndex
  state.currentRowBindings = prevRow
  return { html: chunks.join(''), rows }
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
): { html: string; rowsByKey: Map<string, ItemBinding[]> } {
  unregisterBindingsForScope(state, listSlotId)
  const chunks: string[] = []
  const rowsByKey = new Map<string, ItemBinding[]>()
  for (let i = 0; i < items.length; i++) {
    const key = keys[i]!
    const row = renderKeyedItem(state, listSlotId, items[i] as T, i, key, fn)
    chunks.push(row.html)
    rowsByKey.set(key, row.bindings)
  }
  return { html: chunks.join(''), rowsByKey }
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
): { html: string; bindings: ItemBinding[] } {
  const token = keyToken(key)
  unregisterBindingsForScope(state, keyedScopePrefix(listSlotId, token))
  pushKeyedScope(state, listSlotId, token)

  // Item-value binding context for this row (option C, keyed), save/restore
  // around the body so a nested each() doesn't clobber it.
  const prevItem = state.currentItem
  const prevIndex = state.currentItemIndex
  const prevRow = state.currentRowBindings
  const bindings: ItemBinding[] = []
  state.currentItem = item
  state.currentItemIndex = index
  state.currentRowBindings = bindings

  let html: string
  try {
    const fragment = fn(item, index)
    if (!isHtmlFragment(fragment)) {
      throw new Error('stator: each() callback must return an html`...` result')
    }
    html = fragment.html
  } finally {
    state.currentItem = prevItem
    state.currentItemIndex = prevIndex
    state.currentRowBindings = prevRow
    popListScope(state)
  }
  if (!isSingleRootElement(html)) {
    throw new Error(
      `stator: keyed each() item "${key}" must render exactly one root element — ` +
        `per-item patches address list children by index, so multi-root (or bare-text) ` +
        `items would corrupt sibling indices`,
    )
  }
  return { html, bindings }
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
