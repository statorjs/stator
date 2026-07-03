import ts from 'typescript'
import type { ClientDirective, ClientElement } from './client-script.ts'
import { CompileError } from './diagnostics.ts'

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
  "import { StatorElement, defineElement, use, machine, bind, effect, dispatch } from '@statorjs/stator/client'"

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
    const node = `n${i++}`
    lines.push(`    const ${node} = this.querySelector('[data-b="${marker}"]')`)
    lines.push(`    if (${node}) {`)
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
  // bind:
  const target = d.target ?? 'text'
  const thunk = `() => (${rewriteMembers(d.expr, members)})`
  const deps = `[${d.deps.map((dep) => `this.${dep}`).join(', ')}]`

  // value / checked are TWO-WAY: state→DOM (below) PLUS a DOM→state listener
  // that `@set`s the bound context key. The expression must be a settable
  // `<actor>.<key>` path (a derived selector can't be assigned).
  if (target === 'value' || target === 'checked') {
    const path = parseTwoWayPath(d.expr)
    if (!path) {
      throw new CompileError(
        `stator: bind:${target}={${d.expr}} must bind to a settable context path ` +
          `like \`actor.key\` (a derived value can't be two-way bound).`,
      )
    }
    const writer = emitWriter(node, target)
    const read = target === 'checked' ? `${node}.checked` : `${node}.value`
    const guard = target === 'value' ? `if (e.isComposing) return; ` : ''
    const setter =
      `${node}.addEventListener(${JSON.stringify(target === 'value' ? 'input' : 'change')}, (e) => { ` +
      `${guard}this.${path.actor}.send({ type: '@set', key: ${JSON.stringify(path.key)}, value: ${read} }) })`
    return `this.track(bind(${deps}, ${thunk}, ${writer}));\n      ${setter}`
  }

  const writer = emitWriter(node, target)
  return `this.track(bind(${deps}, ${thunk}, ${writer}))`
}

/** Parse a two-way bind expression `actor.key` into its parts; null if it isn't
 *  a simple single-level member access (not assignable). */
function parseTwoWayPath(expr: string): { actor: string; key: string } | null {
  const m = expr.trim().match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
  return m ? { actor: m[1]!, key: m[2]! } : null
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
    case 'text':
      return `(v) => { ${node}.textContent = v == null ? '' : String(v) }`
    case 'html':
      return `(v) => { ${node}.innerHTML = v == null ? '' : String(v) }`
    case 'value':
      // Loop-break: only write when the DOM differs, so the echo from the user's
      // own keystroke no-ops and the caret is preserved.
      return `(v) => { const s = v == null ? '' : String(v); if (${node}.value !== s) ${node}.value = s }`
    case 'disabled':
    case 'hidden':
    case 'checked':
      return `(v) => { if (${node}.${target} !== !!v) ${node}.${target} = !!v }`
    default:
      // arbitrary attribute
      return `(v) => { if (v == null || v === false) ${node}.removeAttribute(${JSON.stringify(target)}); else ${node}.setAttribute(${JSON.stringify(target)}, v === true ? '' : String(v)) }`
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
        (n.parent as any).name === n
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
