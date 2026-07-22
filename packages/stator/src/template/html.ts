import {
  allocSlotId,
  type RenderState,
  registerBinding,
  requireCurrentRenderState,
} from '../server/render-context.ts'
import { isUrlAttribute, safeAttrUrl } from '../wire/safe-url.ts'
import { escapeAttribute, escapeText, HtmlBuilder, type ValuePosition } from './parser.ts'
import { createHtmlFragment, type HtmlFragment, isHtmlFragment } from './types.ts'

/**
 * Wrap a trusted HTML string so it's emitted **verbatim** — bypassing the text
 * auto-escaping that `{value}` interpolation otherwise applies. The server
 * analog of `set:html` / `dangerouslySetInnerHTML`.
 *
 * The string is injected unescaped: only pass markup you constructed or fully
 * trust, never unsanitized user input. Typical use is a serialized data block
 * (e.g. `<script type="application/ld+json">`) where the payload is already
 * escaped for its context.
 */
export function raw(html: string): HtmlFragment {
  return createHtmlFragment(html)
}

import { isBranchResult } from './conditional.ts'
import { isDeferResult } from './defer.ts'
import {
  type DirectiveContext,
  type DirectiveInvocation,
  isDirectiveInvocation,
} from './directives/core.ts'
import { type ItemReadResult, isEachResult, isItemReadResult } from './each.ts'
import { isReadResult, type ReadResult } from './read.ts'

export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlFragment {
  const state = requireCurrentRenderState()
  const builder = new HtmlBuilder(state)

  for (let i = 0; i < strings.length; i++) {
    builder.pushStatic(strings[i]!)
    if (i < values.length) {
      processValue(builder, state, values[i])
    }
  }

  return createHtmlFragment(builder.toString())
}

/** URL-scheme guard for attribute interpolation: on url-bearing attributes
 *  (href/src/…), strip a javascript:/vbscript: value; other attributes pass
 *  through unchanged. Mirrored on the live-update path (server/recompute.ts) so
 *  a value that's safe at first render can't turn dangerous via a patch. */
function sanitizeAttrValue(attrName: string, value: string): string {
  return isUrlAttribute(attrName) ? safeAttrUrl(value) : value
}

function processValue(builder: HtmlBuilder, state: RenderState, value: unknown): void {
  const pos = builder.positionForValue()
  if (pos.kind === 'invalid') {
    throw new Error(`stator: ${pos.reason}`)
  }

  if (isDirectiveInvocation(value)) {
    if (pos.kind !== 'directive') {
      throw new Error(
        'stator: directive must be in attribute-name position (between tag name and `>`, not inside an attribute value)',
      )
    }
    invokeDirective(builder, value, pos.elementId)
    return
  }

  if (isHtmlFragment(value)) {
    if (pos.kind !== 'text') {
      throw new Error('stator: cannot inline an html`...` fragment outside text position')
    }
    builder.pushRaw(value.html)
    return
  }

  // Arrays splice recursively: `{items.map((i) => <li>…</li>)}` is the
  // static-list idiom (each() remains the REACTIVE list primitive). Mixed
  // arrays are fine — fragments splice, scalars escape.
  if (Array.isArray(value) && pos.kind === 'text') {
    for (const item of value) processValue(builder, state, item)
    return
  }

  if (isEachResult(value)) {
    if (pos.kind !== 'text') {
      throw new Error('stator: cannot inline an each() result outside text position')
    }
    builder.pushRaw(value.html)
    return
  }

  if (isBranchResult(value)) {
    if (pos.kind !== 'text') {
      throw new Error('stator: cannot inline a when()/match() result outside text position')
    }
    builder.pushRaw(value.html)
    return
  }

  if (isDeferResult(value)) {
    if (pos.kind !== 'text') {
      throw new Error('stator: cannot inline a defer() result outside text position')
    }
    builder.pushRaw(value.html)
    return
  }

  if (isReadResult(value)) {
    handleRead(builder, state, value, pos)
    return
  }

  // read(item, …) → itemBind: register the per-row binding by position (text span
  // or attribute), the item analog of handleRead.
  if (isItemReadResult(value)) {
    handleItemRead(builder, state, value, pos)
    return
  }

  if (pos.kind === 'text') {
    builder.pushRaw(escapeText(stringifyValue(value)))
    return
  }
  if (pos.kind === 'attr-value') {
    builder.pushRaw(escapeAttribute(sanitizeAttrValue(pos.attrName, stringifyValue(value))))
    return
  }
  throw new Error(`stator: cannot interpolate a plain value at ${pos.kind} position`)
}

function invokeDirective(builder: HtmlBuilder, inv: DirectiveInvocation, elementId: string): void {
  const ctx: DirectiveContext<unknown> = {
    elementId,
    modifier: inv.modifier,
    arg: inv.arg,
    addAttribute: (name, value) => {
      builder.addAttribute(name, value)
    },
    registerCleanup: () => {
      // POC: no server-side cleanup
    },
  }
  inv.directive.apply(ctx)
}

function handleRead(
  builder: HtmlBuilder,
  state: RenderState,
  r: ReadResult,
  pos: ValuePosition,
): void {
  if (pos.kind === 'text') {
    registerBinding(state, {
      slotId: r.slotId,
      machineName: r.machineName,
      selector: r.selector,
      lastValue: r.value,
      kind: 'text',
    })
    builder.pushRaw(`<span data-slot="${r.slotId}">${escapeText(stringifyValue(r.value))}</span>`)
    return
  }
  if (pos.kind === 'attr-value') {
    if (pos.hasLiteralText) {
      throw new Error(
        `stator: attribute "${pos.attrName}" mixes literal text with a read(). ` +
          `An attribute value must come from a single source — either the entire value ` +
          `inside one read() / selector, or a directive like class:list / style:list ` +
          `that owns the whole attribute.`,
      )
    }
    registerBinding(state, {
      slotId: r.slotId,
      machineName: r.machineName,
      selector: r.selector,
      lastValue: r.value,
      kind: 'attr',
      attrName: pos.attrName,
      parentId: pos.elementId,
    })
    // Boolean semantics: false/null/undefined mean the attribute is ABSENT
    // (`disabled={read(...)}` must be able to un-disable), true means
    // present-and-empty. Everything else stringifies as before. The patch
    // side mirrors this: see recompute's attrWireValue.
    if (r.value === false || r.value === null || r.value === undefined) {
      builder.omitCurrentAttribute()
    } else if (r.value !== true) {
      builder.pushRaw(escapeAttribute(sanitizeAttrValue(pos.attrName, stringifyValue(r.value))))
    }
    return
  }
  throw new Error(`stator: read() result cannot be interpolated at ${pos.kind} position`)
}

/** Register a `read(item, …)` per-row binding by position — the item analog of
 *  handleRead. Pushes onto the row's binding list (owned by the ListBinding), not
 *  state.bindings; recompute diffs it per row and emits text- or attr-op patches. */
function handleItemRead(
  builder: HtmlBuilder,
  state: RenderState,
  r: ItemReadResult,
  pos: ValuePosition,
): void {
  const row = state.currentRowBindings
  if (!row) throw new Error('stator: read(item, …) must be interpolated inside an each() row')
  if (pos.kind === 'text') {
    const slotId = allocSlotId(state)
    row.push({ kind: 'text', slotId, selector: r.selector, lastValue: r.value })
    builder.pushRaw(`<span data-slot="${slotId}">${escapeText(stringifyValue(r.value))}</span>`)
    return
  }
  if (pos.kind === 'attr-value') {
    if (pos.hasLiteralText) {
      throw new Error(
        `stator: attribute "${pos.attrName}" mixes literal text with a read(item, …). ` +
          `An attribute value must come from a single source.`,
      )
    }
    row.push({
      kind: 'attr',
      attrName: pos.attrName,
      parentId: pos.elementId,
      selector: r.selector,
      lastValue: r.value,
    })
    // Same boolean semantics as a machine attr read (see handleRead).
    if (r.value === false || r.value === null || r.value === undefined) {
      builder.omitCurrentAttribute()
    } else if (r.value !== true) {
      builder.pushRaw(escapeAttribute(sanitizeAttrValue(pos.attrName, stringifyValue(r.value))))
    }
    return
  }
  throw new Error(`stator: read(item, …) cannot be interpolated at ${pos.kind} position`)
}

function stringifyValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(stringifyValue).join('')
  return String(v)
}
