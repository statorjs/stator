import {
  allocSlotId,
  type RenderState,
  registerBinding,
  requireCurrentRenderState,
} from '../../server/render-context.ts'
import { isItemReadResult } from '../each.ts'
import { isReadResult, type ReadResult } from '../read.ts'
import { type DirectiveInvocation, defineDirective, invoke } from './core.ts'

/**
 * Shared shape for compound-attribute directives (`class:list`, `style:list`).
 * Each directive owns an entire attribute. Conditional reads appear *inside*
 * the spec, never alongside literal text — that rule is enforced by html.ts.
 *
 * The directive registers one attr binding per unique machine appearing in
 * the spec; each binding's selector recomposes the full attribute value, so
 * any machine event that affects the spec emits exactly one patch for the
 * attribute (and the value always includes every static entry).
 */

type ConditionalEntry<TValue> = TValue | ReadResult<TValue>

/** Resolve the machine instance a spec read evaluates against. During a
 *  fan-out recompute this returns the CURRENT proxy — the ReadResult's captured
 *  `.instance` was frozen at first render, and `rehydrate()` has since replaced
 *  the connection's actor (FINDINGS #3, one composition boundary further out:
 *  the spec object outlives the render that built it). Null runtime (initial
 *  render, request-scoped recompute) falls back to the captured instance,
 *  which is current there by construction. */
type InstanceResolver = (r: ReadResult<unknown>) => unknown

/** Recursive shape accepted by class:list. */
export type ClassListSpec =
  | string
  | false
  | null
  | undefined
  | ReadResult<string | boolean | null | undefined>
  | Record<string, ConditionalEntry<boolean | null | undefined>>
  | ClassListSpec[]

/** Recursive shape accepted by style:list. */
export type StyleListSpec =
  | string
  | false
  | null
  | undefined
  | ReadResult<string | null | undefined>
  | Record<string, ConditionalEntry<string | number | null | undefined>>
  | StyleListSpec[]

function evalRead<T>(value: ConditionalEntry<T>, resolve: InstanceResolver): T {
  return isReadResult(value) ? (value.selector(resolve(value)) as T) : value
}

/** Backstop for hand-written templates (the compiler rejects this at build
 *  time): an item read inside a `:list` spec would stringify as garbage AND
 *  never re-diff — the compound directive recomposes per machine, not per row. */
function rejectItemRead(v: unknown): void {
  if (isItemReadResult(v)) {
    throw new Error(
      'stator: read(item, …) is not supported inside a class:list/style:list spec — the ' +
        'compound directive recomposes per machine, not per row. Give the whole attribute ' +
        'a single item read, or use a machine read inside the spec.',
    )
  }
}

function collectMachines(spec: unknown, out: Set<string>): void {
  rejectItemRead(spec)
  if (spec == null || spec === false) return
  if (typeof spec === 'string') return
  if (isReadResult(spec)) {
    out.add(spec.machineName)
    return
  }
  if (Array.isArray(spec)) {
    for (const item of spec) collectMachines(item, out)
    return
  }
  if (typeof spec === 'object') {
    for (const v of Object.values(spec)) {
      rejectItemRead(v)
      if (isReadResult(v)) out.add(v.machineName)
    }
  }
}

function composeClass(spec: ClassListSpec, resolve: InstanceResolver): string {
  const parts: string[] = []
  walkClass(spec, parts, resolve)
  return parts.join(' ')
}

function walkClass(spec: ClassListSpec, out: string[], resolve: InstanceResolver): void {
  if (spec == null || spec === false) return
  if (typeof spec === 'string') {
    if (spec.length > 0) out.push(spec)
    return
  }
  if (isReadResult(spec)) {
    const v = spec.selector(resolve(spec))
    if (typeof v === 'string' && v.length > 0) out.push(v)
    return
  }
  if (Array.isArray(spec)) {
    for (const item of spec) walkClass(item, out, resolve)
    return
  }
  if (typeof spec === 'object') {
    for (const [name, cond] of Object.entries(spec)) {
      const truthy = evalRead(cond, resolve)
      if (truthy) out.push(name)
    }
  }
}

function composeStyle(spec: StyleListSpec, resolve: InstanceResolver): string {
  const decls: string[] = []
  walkStyle(spec, decls, resolve)
  return decls.join('; ')
}

function walkStyle(spec: StyleListSpec, out: string[], resolve: InstanceResolver): void {
  if (spec == null || spec === false) return
  if (typeof spec === 'string') {
    const trimmed = spec.trim()
    if (trimmed.length > 0) out.push(trimmed.replace(/;\s*$/, ''))
    return
  }
  if (isReadResult(spec)) {
    const v = spec.selector(resolve(spec))
    if (typeof v === 'string' && v.trim().length > 0) {
      out.push(v.trim().replace(/;\s*$/, ''))
    }
    return
  }
  if (Array.isArray(spec)) {
    for (const item of spec) walkStyle(item, out, resolve)
    return
  }
  if (typeof spec === 'object') {
    for (const [prop, raw] of Object.entries(spec)) {
      const value = evalRead(raw, resolve)
      if (value == null || value === '') continue
      // A single property's value must not carry `;` — a `read()`-sourced value
      // like `red; position: fixed; …` would otherwise inject extra
      // declarations (overlay / `url()` exfil). Cut at the first `;`.
      const safe = cssValue(String(value))
      if (safe === '') continue
      out.push(`${prop}: ${safe}`)
    }
  }
}

/** One declaration's value: everything up to the first `;` (the declaration
 *  separator), trimmed. Blocks reactive CSS-value injection while leaving legit
 *  values — including `url(...)` — intact. */
function cssValue(v: string): string {
  const semi = v.indexOf(';')
  return (semi === -1 ? v : v.slice(0, semi)).trim()
}

/**
 * Register one attr-binding per unique machine the spec depends on. Each
 * binding's selector ignores its arg and recomputes the entire attribute
 * by re-walking the spec — every ReadResult inside re-evaluates its selector
 * against the RESOLVED instance (current proxy under a fan-out recompute,
 * the captured one otherwise), returning fresh state.
 */
function bindListAttr<TSpec>(
  state: RenderState,
  spec: TSpec,
  attrName: string,
  elementId: string,
  compose: (spec: TSpec, resolve: InstanceResolver) => string,
): string {
  const machines = new Set<string>()
  collectMachines(spec, machines)

  // Resolution is per-evaluation, through the render state the binding was
  // registered under — recompute sets `currentRuntime` for the fan-out pass.
  const resolve: InstanceResolver = (r) =>
    state.currentRuntime?.proxyFor(r.machineName) ?? r.instance

  const initial = compose(spec, resolve)
  for (const machineName of machines) {
    const slotId = allocSlotId(state)
    registerBinding(state, {
      slotId,
      machineName,
      selector: () => compose(spec, resolve),
      lastValue: initial,
      kind: 'attr',
      attrName,
      parentId: elementId,
    })
  }
  return initial
}

const classListDirective = defineDirective<ClassListSpec>({
  name: 'class:list',
  apply({ elementId, arg, addAttribute }) {
    const state = requireCurrentRenderState()
    const initial = bindListAttr(state, arg, 'class', elementId, composeClass)
    addAttribute('class', initial)
  },
})

const styleListDirective = defineDirective<StyleListSpec>({
  name: 'style:list',
  apply({ elementId, arg, addAttribute }) {
    const state = requireCurrentRenderState()
    const initial = bindListAttr(state, arg, 'style', elementId, composeStyle)
    addAttribute('style', initial)
  },
})

export function classList(spec: ClassListSpec): DirectiveInvocation<ClassListSpec> {
  return invoke(classListDirective, '', spec)
}

export function styleList(spec: StyleListSpec): DirectiveInvocation<StyleListSpec> {
  return invoke(styleListDirective, '', spec)
}
