import ts from 'typescript'
import { elementMarkerSelector } from '../wire/island-markers.ts'
import type { ClientDirective, ClientElement } from './client-script.ts'
import { CLIENT_AUTHOR_GLOBALS, CLIENT_LOWERING_TARGETS, importLine } from './emit-names.ts'
import { mark } from './source-map.ts'

/**
 * Emit the client entry module for a client component: the
 * author's `<script>` (with auto-injected primitives) plus a generated subclass
 * whose `setup()` wires the collected directives, then `defineElement`.
 *
 * Member references in template expressions (`qty.count`, `inc`) are class
 * members, so they're rewritten to `this.<member>` inside the generated setup().
 * A subclass — rather than AST surgery on the author's class — keeps the user
 * class as written; the subclass overrides `setup()`.
 */

const PRIMITIVES = importLine(
  [...CLIENT_AUTHOR_GLOBALS, ...CLIENT_LOWERING_TARGETS],
  '@statorjs/stator/client',
)

export interface EmitClientInput {
  /** The author's `<script>` source. */
  script: string
  element: ClientElement
  directives: ClientDirective[]
  /** All class member names (fields + methods) for `this.` rewriting. */
  members: Set<string>
  /** Where `script` starts in the `.stator` source. Given when the compile is
   *  source-mapped: the script and each wiring line are marked to their source
   *  positions (see `source-map.ts`). */
  scriptAt?: number
  /** The class declares `static attrs`: type `this.attrs` from it. */
  typedAttrs?: boolean
  /** Fence type declarations the script refers to (see `fenceTypesFor`). */
  fenceTypes?: string[]
}

/** Types an island's `this.attrs` from the value of its `static attrs`: an
 *  interface merged onto the class, so the author's own methods see it. */
export const attrsInterface = (className: string): string =>
  `export interface ${className} { get attrs(): import('@statorjs/stator/client').AttrsOf<typeof ${className}.attrs> }`

export function emitClientModule(input: EmitClientInput): string {
  const { script, element, directives, members, scriptAt } = input
  const at = (d: ClientDirective): string => (d.at !== undefined ? mark(d.at) : '')
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
        lines.push(
          `    ${at(d)}this.track(bindSlot(this, ${JSON.stringify(marker)}, ${deps}, ${thunk}))`,
        )
      }
      continue
    }
    // Element wiring: every occurrence of the marker is wired — a marked
    // element inside a `.map()` repeats per row.
    const node = `n${i++}`
    lines.push(
      `    ${group[0] ? at(group[0]) : ''}for (const ${node} of this.querySelectorAll(${JSON.stringify(elementMarkerSelector(marker))})) {`,
    )
    for (const d of group) lines.push(`      ${at(d)}${wireDirective(node, d, members)}`)
    lines.push('    }')
  }

  return [
    PRIMITIVES,
    '',
    emitScript(script, scriptAt),
    '',
    `class ${impl} extends ${element.className} {`,
    '  setup() {',
    ...lines,
    '  }',
    '}',
    `defineElement(${impl}, ${JSON.stringify(element.tag)})`,
    // Type-only, and after the code: declarations hoist, and nothing above
    // moves off its source line.
    ...(input.typedAttrs ? [attrsInterface(element.className)] : []),
    ...(input.fenceTypes ?? []),
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

/** on: handler — a bare method reference becomes
 *  `(e) => (this.m as (e: Event) => unknown)(e)`, which typechecks the way
 *  passing `this.m` as a listener does: a method taking no argument, or a
 *  narrower event, is accepted; an incompatible parameter is an error. The
 *  assertion erases to `(this.m)(e)`, a call with `this` intact. Any other
 *  expression is used directly (with member references rewritten). */
function emitHandler(expr: string, members: Set<string>): string {
  const t = expr.trim()
  if (/^[A-Za-z_$][\w$]*$/.test(t) && members.has(t)) {
    return `(e) => (this.${t} as (e: Event) => unknown)(e)`
  }
  return rewriteMembers(expr, members)
}

function emitWriter(node: string, target: string): string {
  switch (target) {
    case 'disabled':
    case 'hidden':
      // Boolean IDL properties write as properties, not attributes. The node
      // is typed `Element`, which declares neither.
      return `(v) => { const el = ${node} as Element & { ${target}: boolean }; if (el.${target} !== !!v) el.${target} = !!v }`
    default:
      // arbitrary attribute — the shared attr contract (wire/attr-value.ts)
      return `(v) => setAttr(${node}, ${JSON.stringify(target)}, attrValue(v))`
  }
}

/** Remove any author import from `@statorjs/stator/client` — those primitives are
 *  auto-injected (the `PRIMITIVES` line), so an author's habit-import would be a
 *  duplicate binding. Server machine imports (for `dispatch`) are untouched. */
/** Drop the author's own `@statorjs/stator/client` imports (the module imports
 *  those primitives itself). Line-preserving: the import's newlines stay, so
 *  every later line of the script keeps its line number. */
function stripClientPrimitiveImports(script: string): string {
  return script.replace(
    /^[ \t]*import\s+\{[^}]*\}\s+from\s+['"]@statorjs\/stator\/client['"][ \t]*;?[ \t]*$/gm,
    (m) => m.replace(/[^\n]/g, ''),
  )
}

/** The author's script as it goes into the client module. With `scriptAt`,
 *  each line's first token is marked to its position in the source: the strip
 *  keeps line numbers, and a line it did not touch keeps its columns. */
function emitScript(script: string, scriptAt?: number): string {
  const stripped = stripClientPrimitiveImports(script)
  const body = stripped.trim()
  if (scriptAt === undefined) return body
  const lineStarts = [0]
  for (let i = script.indexOf('\n'); i !== -1; i = script.indexOf('\n', i + 1))
    lineStarts.push(i + 1)
  const lead = stripped.length - stripped.trimStart().length
  const leadLines = stripped.slice(0, lead).split('\n').length - 1
  const firstCol = lead - (stripped.lastIndexOf('\n', lead - 1) + 1)
  return body
    .split('\n')
    .map((line, k) => {
      const start = lineStarts[leadLines + k]
      const indent = line.length - line.trimStart().length
      if (start === undefined || indent === line.length) return line
      const col = (k === 0 ? firstCol : 0) + indent
      return line.slice(0, indent) + mark(scriptAt + start + col) + line.slice(indent)
    })
    .join('\n')
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
