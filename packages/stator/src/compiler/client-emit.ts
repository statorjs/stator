import ts from 'typescript'
import { elementMarkerSelector } from '../wire/island-markers.ts'
import type { ClientDirective, ClientElement } from './client-script.ts'

/**
 * Phase 3b stage 5 — emit the client entry module for a client component: the
 * author's `<script>` (with auto-injected primitives) plus a generated subclass
 * whose `setup()` wires the collected directives, then `defineElement`.
 *
 * Member references in template expressions (`qty.count`, `inc`) are class
 * members, so they're rewritten to `this.<member>` inside the generated setup().
 * A subclass — rather than AST surgery on the author's class — keeps the user
 * class as written; the subclass overrides `setup()`.
 */

const PRIMITIVES =
  "import { StatorElement, defineElement, use, machine, bind, bindSlot, effect, dispatch, attrValue, setAttr } from '@statorjs/stator/client'"

export interface EmitClientInput {
  /** The author's `<script>` source. */
  script: string
  element: ClientElement
  directives: ClientDirective[]
  /** All class member names (fields + methods) for `this.` rewriting. */
  members: Set<string>
}

export function emitClientModule(input: EmitClientInput): string {
  const { script, element, directives, members } = input
  const impl = `__${element.className}Impl`

  // Group directives by node marker (one querySelector per marked element).
  const byMarker = new Map<string, ClientDirective[]>()
  for (const d of directives) {
    const list = byMarker.get(d.marker) ?? []
    list.push(d)
    byMarker.set(d.marker, list)
  }

  const lines: string[] = []
  let i = 0
  for (const [marker, group] of byMarker) {
    if (group[0]?.kind === 'slot') {
      // Text slot: the runtime finds every `<!--sN-->` comment, materializes a
      // text node per occurrence, and binds them all to the one thunk.
      for (const d of group) {
        const thunk = `() => (${rewriteMembers(d.expr, members)})`
        const deps = `[${d.deps.map((dep) => `this.${dep}`).join(', ')}]`
        lines.push(`    this.track(bindSlot(this, ${JSON.stringify(marker)}, ${deps}, ${thunk}))`)
      }
      continue
    }
    // Element wiring: every occurrence of the marker is wired — a marked
    // element inside a `.map()` repeats per row.
    const node = `n${i++}`
    lines.push(
      `    for (const ${node} of this.querySelectorAll(${JSON.stringify(elementMarkerSelector(marker))})) {`,
    )
    for (const d of group) lines.push(`      ${wireDirective(node, d, members)}`)
    lines.push('    }')
  }

  return [
    PRIMITIVES,
    '',
    stripClientPrimitiveImports(script).trim(),
    '',
    `class ${impl} extends ${element.className} {`,
    '  setup() {',
    ...lines,
    '  }',
    '}',
    `defineElement(${impl}, ${JSON.stringify(element.tag)})`,
    '',
  ].join('\n')
}

function wireDirective(node: string, d: ClientDirective, members: Set<string>): string {
  if (d.kind === 'on') {
    const handler = emitHandler(d.expr, members)
    return `${node}.addEventListener(${JSON.stringify(d.event)}, ${handler})`
  }
  // kind 'bind': an attribute-position client read() — one-way display.
  const target = d.target ?? 'text'
  const thunk = `() => (${rewriteMembers(d.expr, members)})`
  const deps = `[${d.deps.map((dep) => `this.${dep}`).join(', ')}]`
  const writer = emitWriter(node, target)
  return `this.track(bind(${deps}, ${thunk}, ${writer}))`
}

/** on: handler — a bare method reference becomes `(e) => this.m(e)`; any other
 *  expression is used directly (with member references rewritten). */
function emitHandler(expr: string, members: Set<string>): string {
  const t = expr.trim()
  if (/^[A-Za-z_$][\w$]*$/.test(t) && members.has(t)) {
    return `(e) => this.${t}(e)`
  }
  return rewriteMembers(expr, members)
}

function emitWriter(node: string, target: string): string {
  switch (target) {
    case 'disabled':
    case 'hidden':
      // Boolean IDL properties write as properties, not attributes.
      return `(v) => { if (${node}.${target} !== !!v) ${node}.${target} = !!v }`
    default:
      // arbitrary attribute — the shared attr contract (wire/attr-value.ts)
      return `(v) => setAttr(${node}, ${JSON.stringify(target)}, attrValue(v))`
  }
}

/** Remove any author import from `@statorjs/stator/client` — those primitives are
 *  auto-injected (the `PRIMITIVES` line), so an author's habit-import would be a
 *  duplicate binding. Server machine imports (for `dispatch`) are untouched. */
function stripClientPrimitiveImports(script: string): string {
  return script.replace(
    /^\s*import\s+\{[^}]*\}\s+from\s+['"]@statorjs\/stator\/client['"]\s*;?\s*$/gm,
    '',
  )
}

/** Prefix class-member identifiers in an expression with `this.` (skipping the
 *  property-name side of member access, so `qty.count` → `this.qty.count`). */
export function rewriteMembers(expr: string, members: Set<string>): string {
  const sf = ts.createSourceFile(
    'e.ts',
    `(${expr})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const repls: Array<[start: number, end: number]> = []
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const isPropName = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
      // skip shorthand/binding contexts where `this.` would be invalid
      const isDeclName =
        n.parent &&
        (ts.isParameter(n.parent) || ts.isBindingElement(n.parent)) &&
        n.parent.name === n
      if (!isPropName && !isDeclName && members.has(n.text)) {
        repls.push([n.getStart(sf), n.getEnd()])
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // `(${expr})` adds a leading `(` (offset 1). Strip it back out by slicing.
  let text = `(${expr})`
  repls.sort((a, b) => b[0] - a[0])
  for (const [start, end] of repls) {
    text = `${text.slice(0, start)}this.${text.slice(start, end)}${text.slice(end)}`
  }
  return text.slice(1, -1) // remove the wrapping parens
}
