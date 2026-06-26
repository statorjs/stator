import {
  HtmlBuilder,
  escapeText,
  escapeAttribute,
  type ValuePosition,
} from './parser.ts'
import {
  requireCurrentRenderState,
  registerBinding,
  type RenderState,
} from '../server/render-context.ts'
import {
  isHtmlFragment,
  createHtmlFragment,
  type HtmlFragment,
} from './types.ts'

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
import { isReadResult, type ReadResult } from './read.ts'
import { isEachResult } from './each.ts'
import { isBranchResult } from './conditional.ts'
import {
  isDirectiveInvocation,
  type DirectiveInvocation,
  type DirectiveContext,
} from './directives/core.ts'

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

  if (isReadResult(value)) {
    handleRead(builder, state, value, pos)
    return
  }

  if (pos.kind === 'text') {
    builder.pushRaw(escapeText(stringifyValue(value)))
    return
  }
  if (pos.kind === 'attr-value') {
    builder.pushRaw(escapeAttribute(stringifyValue(value)))
    return
  }
  throw new Error(`stator: cannot interpolate a plain value at ${pos.kind} position`)
}

function invokeDirective(
  builder: HtmlBuilder,
  inv: DirectiveInvocation,
  elementId: string,
): void {
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
    builder.pushRaw(
      `<span data-slot="${r.slotId}">${escapeText(stringifyValue(r.value))}</span>`,
    )
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
    builder.pushRaw(escapeAttribute(stringifyValue(r.value)))
    return
  }
  throw new Error(`stator: read() result cannot be interpolated at ${pos.kind} position`)
}

function stringifyValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(stringifyValue).join('')
  return String(v)
}
