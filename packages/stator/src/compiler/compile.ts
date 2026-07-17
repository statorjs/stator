import ts from 'typescript'
import { emitClientModule } from './client-emit.ts'
import {
  analyzeClient,
  analyzeScriptClasses,
  type ClientDirective,
  isCustomElementTag,
  pascalToKebab,
} from './client-script.ts'
import { CompileError, type DiagnosticLocation, locAt } from './diagnostics.ts'
import { scopeHash } from './hash.ts'
import { type LowerMeta, lowerTemplate } from './lower.ts'
import { splitStator } from './split.ts'
import { scopeCss } from './styles.ts'

/**
 * Assemble a `.stator` source into the server `.ts` module the runtime
 * consumes. Phase 3a: server module only (template + frontmatter). Styles and
 * the client `<script>` are layered in later stages.
 *
 * Frontmatter handling:
 *   - import / type / interface declarations hoist to the module top
 *   - the template runtime primitives are auto-injected (authors write JSX +
 *     `{read(...)}`, never `import ... from '@statorjs/stator/template'` for these)
 *   - other statements (notably `const { x } = Stator.props<P>()`) move inside
 *     the rendered function, with `Stator.props<P>()` rewritten to the `props`
 *     parameter and `P` lifted to the parameter's type
 */

export interface CompileResult {
  /** The server render module source (shell render for a client component). */
  serverCode: string
  /** Per-component scope hash (the `data-s-<hash>` marker uses it). */
  scopeHash: string
  /** Scoped CSS, ready for the Vite CSS pipeline. Empty when there's no
   *  `<style>`. */
  css: string
  /** Raw client `<script>` regions, as authored. */
  scripts: string[]
  /** True when this `.stator` is a client component (whole-file custom element). */
  isClient: boolean
  /** The generated client entry module (Phase 3b) — the `StatorElement` subclass
   *  + `setup()` + `defineElement`. Empty for server components. */
  clientCode: string
  /** Custom-element tag this client component defines (e.g. `quantity-stepper`),
   *  or undefined for a server component. */
  clientTag?: string
}

const PRIMITIVES_IMPORT =
  "import { html, read, each, when, match, defer, on, classList, styleList } from '@statorjs/stator/template'"

export interface CompileOptions {
  /** Stable id for the component (file path). Used for the scope hash so the
   *  hash is stable across edits to unrelated files; falls back to the source.
   *  Also the diagnostics file path. */
  id?: string
  /** Whether this file is a route page or a reusable component. Gates the
   *  frontmatter capability matrix (request/response, reads, props, pragmas).
   *  Defaults to 'component'. The Vite plugin / build sets it from the directory. */
  kind?: 'route' | 'component'
  /** Resolve a component identifier (used in this file) to the named regions it
   *  declares, for cross-file `child="x"` validation. The Vite plugin / build
   *  supplies this (reads sibling `.stator` files). Omitted → validation skipped. */
  resolveRegions?: (componentName: string) => Set<string> | null
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const { frontmatter, template, styles, scripts, scriptOffsets, templateOffset } =
    splitStator(source)
  const kind = opts.kind ?? 'component'

  const hasStyles = styles.length > 0
  const hash = scopeHash(opts.id ?? source)
  const scopeAttr = hasStyles ? `data-s-${hash}` : undefined

  // An inline `<script>` makes this a *client component* (a whole-file custom
  // element) — a different compile path entirely. It must export a
  // `StatorElement`; one that doesn't is a malformed component, not literal
  // markup, so we surface it rather than silently dropping the script.
  const script = scripts.join('\n')
  if (script.trim()) {
    if (analyzeScriptClasses(script).length > 0) {
      return compileClient(template, script, {
        hash,
        scopeAttr,
        styles,
        file: opts.id,
      })
    }
    throw new CompileError(
      `stator: this <script> exports no StatorElement subclass. An inline <script> in a ` +
        `.stator file is compiled as a client component — add ` +
        `\`export class … extends StatorElement { … }\`. To emit a literal script instead, ` +
        `mark it \`<script is:inline>…</script>\` (verbatim inline) or use ` +
        `\`<script src="…">\` (external file).`,
      locAt(source, scriptOffsets[0] ?? 0, opts.id),
    )
  }

  const meta: LowerMeta = {
    usesChildren: false,
    regions: new Set(),
    components: new Set(),
    customElements: new Set(),
    refs: new Set(),
  }
  const htmlExpr = lowerTemplate(template, {
    scopeAttr,
    source,
    templateOffset,
    file: opts.id,
    meta,
    resolveRegions: opts.resolveRegions,
  })
  const css = hasStyles ? scopeCss(styles.join('\n'), hash) : ''

  const fm = processFrontmatter(frontmatter, kind, source, opts.id)
  const serverCode =
    kind === 'route' ? emitRoute(fm, htmlExpr, meta) : emitComponent(fm, htmlExpr, meta)

  return {
    serverCode,
    scopeHash: hash,
    css,
    scripts,
    isClient: false,
    clientCode: '',
  }
}

/**
 * Compile a client component: its template root is the custom element, the
 * `<script>` defines the matching class. Produces (i) a server shell render
 * module — `(props) => HtmlFragment` rendering the custom-element tag with the
 * declared attrs + inner shell (markers + children) — and (ii) the client entry
 * module (the `StatorElement` subclass + wiring).
 */
function compileClient(
  template: string,
  script: string,
  ctx: { hash: string; scopeAttr?: string; styles: string[]; file?: string },
): CompileResult {
  const classes = analyzeScriptClasses(script)
  const root = extractClientRoot(template, ctx.file)

  // Name-match validation (both directions, hyphen rule).
  const tags = new Set([root.tag])
  analyzeClient(script, tags, { file: ctx.file })

  const cls = classes.find((c) => pascalToKebab(c.name) === root.tag)
  if (!cls) {
    // analyzeClient validated the tag↔class match just above; reaching here is a bug.
    throw new CompileError(
      `stator: internal — no exported class matches root <${root.tag}> after name validation`,
    )
  }

  // Lower the inner shell in client mode: collect bind:/on:, strip them, inject
  // markers. Plain expressions (props access, maps with nested JSX, read())
  // flow through to the SHELL and evaluate server-side per use — the hydrate
  // pattern; see the client-components guide.
  const directives: ClientDirective[] = []
  const meta: LowerMeta = {
    usesChildren: false,
    regions: new Set(),
    components: new Set(),
    customElements: new Set(),
    refs: new Set(),
  }
  // Client components scope styles by DESCENDANT of the root (the class may
  // create DOM at runtime — per-element attrs could never reach it), so the
  // inner template needs no per-element stamping: only the root carries the
  // scope attribute.
  const innerExpr = lowerTemplate(root.inner, {
    file: ctx.file,
    meta,
    client: { useFields: new Set(cls.useFields.keys()), directives },
  })

  const css = ctx.styles.length
    ? scopeCss(ctx.styles.join('\n'), ctx.hash, { strategy: 'descendant', rootTag: root.tag })
    : ''

  // Server shell module: <tag {attrs}{scope}>{inner}</tag>.
  const attrDecl = `{ ${[...cls.staticAttrs].map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`
  const rootScope = ctx.scopeAttr ? ` data-s-${ctx.hash}` : ''
  const serverCode = [
    "import { html, read, each, when, match, defer, on, classList, styleList, createHtmlFragment, clientShellAttrs } from '@statorjs/stator/template'",
    '',
    `export default function (props = {}) {`,
    `  const __inner = ${innerExpr}`,
    `  const __attrs = clientShellAttrs(props, ${attrDecl}, ${JSON.stringify(root.rootAttrs)})`,
    `  return createHtmlFragment(\`<${root.tag}\${__attrs}${rootScope}>\` + __inner.html + \`</${root.tag}>\`)`,
    '}',
    '',
  ].join('\n')

  const clientCode = emitClientModule({
    script,
    element: { tag: root.tag, className: cls.name },
    directives,
    members: cls.members,
  })

  return {
    serverCode,
    scopeHash: ctx.hash,
    css,
    scripts: [script],
    isClient: true,
    clientCode,
    clientTag: root.tag,
  }
}

/** Static attributes authored on a client component's ROOT element — its own
 *  base `class`, `hidden`, ARIA, `data-*`. These are carried across the
 *  split-and-reassemble so a component can style/flag its own root; the use site
 *  merges them under its props (FINDINGS #4). Namespaced directives (class:list,
 *  on:) and expression-valued attrs are not static and are skipped here. */
function staticRootAttrs(
  attrs: ts.JsxAttributes,
  sf: ts.SourceFile,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr) || ts.isJsxNamespacedName(attr.name)) continue
    const name = attr.name.getText(sf)
    const init = attr.initializer
    if (init === undefined) {
      out[name] = true // valueless boolean attribute
    } else if (ts.isStringLiteral(init)) {
      out[name] = init.text
    }
  }
  return out
}

/** Parse a client template, returning the custom-element root tag, its inner
 *  source (its children), and the root's own static attributes. Enforces "root
 *  must be the custom element". */
function extractClientRoot(
  template: string,
  file?: string,
): { tag: string; inner: string; rootAttrs: Record<string, string | boolean> } {
  const wrapped = `const __t = (<>${template}</>);`
  const sf = ts.createSourceFile('t.tsx', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let fragment: ts.JsxFragment | undefined
  const find = (n: ts.Node): void => {
    if (ts.isJsxFragment(n)) {
      fragment = n
      return
    }
    ts.forEachChild(n, find)
  }
  find(sf)
  const elements = (fragment?.children ?? []).filter(
    (c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c),
  )
  if (elements.length !== 1) {
    throw new CompileError(
      'stator: a client component must have a single custom-element root.',
      file ? { file, line: 1, column: 1, frame: '' } : undefined,
    )
  }
  const rootEl = elements[0]!
  if (ts.isJsxSelfClosingElement(rootEl)) {
    const tag = rootEl.tagName.getText(sf)
    requireCustomRoot(tag, file)
    return { tag, inner: '', rootAttrs: staticRootAttrs(rootEl.attributes, sf) }
  }
  const el = rootEl as ts.JsxElement
  const tag = el.openingElement.tagName.getText(sf)
  requireCustomRoot(tag, file)
  const inner = wrapped.slice(el.openingElement.getEnd(), el.closingElement.getStart())
  return { tag, inner, rootAttrs: staticRootAttrs(el.openingElement.attributes, sf) }
}

function requireCustomRoot(tag: string, file?: string): void {
  if (!isCustomElementTag(tag)) {
    throw new CompileError(
      `stator: a client component's root must be a custom element (a hyphenated tag like ` +
        `<my-widget>), found <${tag}>. A nested custom element under server chrome isn't allowed.`,
      file ? { file, line: 1, column: 1, frame: '' } : undefined,
    )
  }
}

interface FrontmatterParts {
  hoisted: string
  body: string
  propsType?: string
  /** Route only: the machine identifiers from `Stator.reads([...])`. */
  reads: string[]
  /** Route only: pragma flags (`// @stator live`). */
  pragmas: Set<string>
}

const VALID_PRAGMAS = new Set(['live'])

/**
 * Split frontmatter into hoisted declarations (imports/types) and function-body
 * statements, rewriting the `Stator.*` markers per file kind and enforcing the
 * capability matrix.
 *
 * Component: `Stator.props<P>()` → `props`. Route/request/response/pragmas are
 * errors. Route: `Stator.reads([A,B])` RHS → `[__ctx[A.name], __ctx[B.name]]`
 * (and `[A,B]` captured for the `reads:` config); `Stator.request` → `__req`;
 * `Stator.response` → `__ctx.response`. `Stator.props` is an error.
 */
function processFrontmatter(
  fm: string,
  kind: 'route' | 'component',
  source: string,
  file?: string,
): FrontmatterParts {
  const pragmas = parsePragmas(fm, kind, source, file)
  if (!fm.trim()) return { hoisted: '', body: '', reads: [], pragmas }

  const sf = ts.createSourceFile('fm.ts', fm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hoisted: string[] = []
  const body: string[] = []
  let propsType: string | undefined
  const reads: string[] = []

  const locInFm = (node: ts.Node): DiagnosticLocation =>
    locAt(source, fmOffset(source) + node.getStart(sf), file)

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      hoisted.push(stmt.getText(sf))
      continue
    }

    const stmtStart = stmt.getStart(sf)
    let text = stmt.getText(sf)
    const repls: Array<[start: number, end: number, replacement: string]> = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isStatorCall(n, 'props')) {
        if (kind === 'route') {
          throw new CompileError(
            'stator: Stator.props() is not available in a route page (a route has no parent props). ' +
              'Use Stator.reads([...]) to access machines.',
            locInFm(n),
          )
        }
        if (n.typeArguments && n.typeArguments.length > 0) {
          propsType = n.typeArguments[0]!.getText(sf)
        }
        repls.push([n.getStart(sf), n.getEnd(), 'props'])
        return
      }
      if (ts.isCallExpression(n) && isStatorCall(n, 'reads')) {
        if (kind !== 'route') {
          throw new CompileError(
            'stator: Stator.reads() is only available in a route page. ' +
              'A component receives machines as props.',
            locInFm(n),
          )
        }
        const arg = n.arguments[0]
        if (!arg || !ts.isArrayLiteralExpression(arg)) {
          throw new CompileError('stator: Stator.reads(...) takes an array of machines', locInFm(n))
        }
        const ids = arg.elements.map((el) => el.getText(sf))
        reads.push(...ids)
        const bound = `[${ids.map((id) => `__ctx[${id}.name]`).join(', ')}]`
        repls.push([n.getStart(sf), n.getEnd(), bound])
        return
      }
      if (ts.isPropertyAccessExpression(n) && isStatorMember(n, 'request')) {
        requireRoute('Stator.request', kind, locInFm(n))
        repls.push([n.getStart(sf), n.getEnd(), '__req'])
        return
      }
      if (ts.isPropertyAccessExpression(n) && isStatorMember(n, 'response')) {
        requireRoute('Stator.response', kind, locInFm(n))
        repls.push([n.getStart(sf), n.getEnd(), '__ctx.response'])
        return
      }
      ts.forEachChild(n, visit)
    }
    visit(stmt)
    repls.sort((a, b) => b[0] - a[0])
    for (const [start, end, replacement] of repls) {
      text = text.slice(0, start - stmtStart) + replacement + text.slice(end - stmtStart)
    }
    body.push(`  ${text}`)
  }

  return {
    hoisted: hoisted.join('\n'),
    body: body.join('\n'),
    propsType,
    reads,
    pragmas,
  }
}

function emitComponent(fm: FrontmatterParts, htmlExpr: string, meta: LowerMeta): string {
  let param = ''
  if (fm.propsType && meta.usesChildren) param = `props: ${fm.propsType} & { children?: any }`
  else if (fm.propsType) param = `props: ${fm.propsType}`
  else if (meta.usesChildren) param = `props: { children?: any }`

  const lines = [PRIMITIVES_IMPORT]
  if (fm.hoisted) lines.push(fm.hoisted)
  lines.push('')
  lines.push(`export default function (${param}) {`)
  if (fm.body) lines.push(fm.body)
  lines.push(`  return ${htmlExpr}`)
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function emitRoute(fm: FrontmatterParts, htmlExpr: string, _meta: LowerMeta): string {
  const lines = [PRIMITIVES_IMPORT, "import { defineRoute } from '@statorjs/stator/server'"]
  if (fm.hoisted) lines.push(fm.hoisted)
  lines.push('')
  lines.push('export const GET = defineRoute({')
  lines.push(`  reads: [${fm.reads.join(', ')}],`)
  if (fm.pragmas.has('live')) lines.push('  live: true,')
  lines.push('  render: (__ctx, __req) => {')
  if (fm.body) lines.push(fm.body)
  lines.push(`    return ${htmlExpr}`)
  lines.push('  },')
  lines.push('})')
  return `${lines.join('\n')}\n`
}

/** Parse `// @stator <flag>` comment pragmas from the frontmatter text. */
function parsePragmas(
  fm: string,
  kind: 'route' | 'component',
  source: string,
  file?: string,
): Set<string> {
  const out = new Set<string>()
  const re = /\/\/\s*@stator\s+(\S+)/g
  for (const m of fm.matchAll(re)) {
    const flag = m[1]!
    if (!VALID_PRAGMAS.has(flag)) {
      throw new CompileError(
        `stator: unknown pragma "// @stator ${flag}". Known flags: ${[...VALID_PRAGMAS].join(', ')}.`,
        locAt(source, fmOffset(source) + m.index, file),
      )
    }
    if (kind !== 'route') {
      throw new CompileError(
        `stator: "// @stator ${flag}" is only valid in a route page, not a component.`,
        locAt(source, fmOffset(source) + m.index, file),
      )
    }
    out.add(flag)
  }
  return out
}

function requireRoute(what: string, kind: 'route' | 'component', loc: DiagnosticLocation): void {
  if (kind !== 'route') {
    throw new CompileError(
      `stator: ${what} is only available in a route page, not a component. ` +
        `Read it in the route and pass the value down as a prop.`,
      loc,
    )
  }
}

/** Character offset of the frontmatter body in the original source (after the
 *  opening `---\n`). 4 = `---\n`; good enough for diagnostics line/col. */
function fmOffset(source: string): number {
  return source.startsWith('---') ? source.indexOf('\n') + 1 : 0
}

function isStatorCall(call: ts.CallExpression, member: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) && isStatorMember(call.expression, member)
}

function isStatorMember(e: ts.PropertyAccessExpression, member: string): boolean {
  return ts.isIdentifier(e.expression) && e.expression.text === 'Stator' && e.name.text === member
}
