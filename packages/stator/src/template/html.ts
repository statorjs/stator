import {
  allocSlotId,
  type RenderState,
  registerBinding,
  requireCurrentRenderState,
} from '../server/render-context.ts'
import { attrValue, sanitizeAttr, textValue } from '../wire/attr-value.ts'
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
    builder.pushRaw(escapeText(textValue(value)))
    return
  }
  if (pos.kind === 'attr-value') {
    // The shared attr contract (wire/attr-value.ts): null → attribute ABSENT.
    const av = attrValue(value)
    if (av === null) builder.omitCurrentAttribute()
    else builder.pushRaw(escapeAttribute(sanitizeAttr(pos.attrName, av)))
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
    builder.pushRaw(`<span data-slot="${r.slotId}">${escapeText(textValue(r.value))}</span>`)
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
    // The shared attr contract (wire/attr-value.ts) — the same function the
    // patch side (recompute) normalizes with, so render and diff can't drift.
    {
      const av = attrValue(r.value)
      if (av === null) builder.omitCurrentAttribute()
      else builder.pushRaw(escapeAttribute(sanitizeAttr(pos.attrName, av)))
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
  if (!row) {
    throw new Error(
      'stator: read(item, …) interpolated outside an each() row render — an item binding ' +
        'is owned by its row (see the itemBind ownership rule). Use a machine read here.',
    )
  }
  if (pos.kind === 'text') {
    const slotId = allocSlotId(state)
    row.push({ kind: 'text', slotId, selector: r.selector, lastValue: r.value })
    builder.pushRaw(`<span data-slot="${slotId}">${escapeText(textValue(r.value))}</span>`)
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
    // Same shared attr contract as every other attr writer.
    {
      const av = attrValue(r.value)
      if (av === null) builder.omitCurrentAttribute()
      else builder.pushRaw(escapeAttribute(sanitizeAttr(pos.attrName, av)))
    }
    return
  }
  throw new Error(`stator: read(item, …) cannot be interpolated at ${pos.kind} position`)
}
