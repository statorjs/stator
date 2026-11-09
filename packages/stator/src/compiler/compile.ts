import ts from 'typescript'
import { emitClientModule } from './client-emit.ts'
import {
  analyzeClient,
  analyzeScriptClasses,
  type ClientDirective,
  isCustomElementTag,
  pascalToKebab,
} from './client-script.ts'
import { contractPragma } from './contract.ts'
import { CompileError, type DiagnosticLocation, locAt, parseDiagnosticsOf } from './diagnostics.ts'
import { READ_RESULT_TYPE_IMPORT, statorPropsType } from './dts.ts'
import {
  ISLAND_SHELL_EXTRAS,
  importLine,
  TEMPLATE_AUTHOR_GLOBALS,
  TEMPLATE_LOWERING_TARGETS,
} from './emit-names.ts'
import { scopeHash } from './hash.ts'
import { type LowerMeta, lowerTemplate } from './lower.ts'
import {
  canMark,
  finalizeSourceMap,
  inlineSourceMapComment,
  markVerbatim,
  type SourceMapV3,
  splice,
  stripMarks,
} from './source-map.ts'
import { splitStator } from './split.ts'
import { scopeCss } from './styles.ts'

/**
 * Assemble a `.stator` source into the server `.ts` module the runtime
 * consumes, plus its scoped CSS and, for an island, the client entry module.
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
  /** Scoped CSS, emitted as is by the dev server and the build. Empty when
   *  there's no `<style>`. */
  css: string
  /** Raw client `<script>` regions, as authored. */
  scripts: string[]
  /** True when this `.stator` is a client component (whole-file custom element). */
  isClient: boolean
  /** The generated client entry module — the `StatorElement` subclass
   *  + `setup()` + `defineElement`. Empty for server components. */
  clientCode: string
  /** Custom-element tag this client component defines (e.g. `quantity-stepper`),
   *  or undefined for a server component. */
  clientTag?: string
  /** The map from `serverCode` back to the `.stator` source, when
   *  `sourceMap` was asked for (also inlined at the end of `serverCode`). */
  map?: SourceMapV3
  /** The map from `clientCode` back to the source, for an island compiled
   *  with `sourceMap` (also inlined at the end of `clientCode`). */
  clientMap?: SourceMapV3
}

type PropsType = ReturnType<typeof statorPropsType>

const PRIMITIVES_IMPORT = importLine(
  [...TEMPLATE_AUTHOR_GLOBALS, ...TEMPLATE_LOWERING_TARGETS],
  '@statorjs/stator/template',
)

const SHELL_PRIMITIVES_IMPORT = importLine(
  [
    ...TEMPLATE_AUTHOR_GLOBALS,
    ...TEMPLATE_LOWERING_TARGETS.filter((n) => n !== 'itemBind'),
    ...ISLAND_SHELL_EXTRAS,
  ],
  '@statorjs/stator/template',
)

export interface CompileOptions {
  /** Stable id for the component (file path). Used for the scope hash so the
   *  hash is stable across edits to unrelated files; falls back to the source.
   *  Also the diagnostics file path. */
  id?: string
  /** Whether this file is a route page or a reusable component. Gates the
   *  frontmatter capability matrix (request/response, reads, props, pragmas).
   *  Defaults to 'component'. The dev server and the build set it from the directory. */
  kind?: 'route' | 'component'
  /** Resolve a component identifier (used in this file) to the named regions it
   *  declares, for cross-file `child="x"` validation. The dev server and the build
   *  supply this (reads sibling `.stator` files). Omitted → validation skipped. */
  resolveRegions?: (componentName: string) => Set<string> | null
  /** Map `serverCode` back to this source: frontmatter statements line for
   *  line, template expressions and component calls at their position. The
   *  map is inlined as a trailing `sourceMappingURL` comment (esbuild chains
   *  it through its own transform) and returned as `map`. `source` is the
   *  map's `sources` entry — whatever path its consumer resolves the
   *  `.stator` file by. An island maps both halves: its shell (server fence
   *  and template) in `serverCode`, its script and directive wiring in
   *  `clientCode`. */
  sourceMap?: { source: string }
  /** Stamp the compiled-shape contract (see `contract.ts`) on line 1 of the
   *  emitted module(s), naming `compiler` as the version that produced them.
   *  The build and `build:lib` stamp; the dev loader need not. */
  stamp?: { compiler: string }
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const {
    frontmatter,
    frontmatterOffset,
    template,
    styles,
    scripts,
    scriptOffsets,
    scriptContentOffsets,
    templateOffset,
  } = splitStator(source)
  const marks = opts.sourceMap != null && canMark(source)
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
      // The island's SERVER FENCE: runs per shell render, on the
      // server only, with its bindings in template scope. The <script>
      // never sees it, in either direction.
      const fm = processFrontmatter(
        frontmatter,
        'island',
        source,
        frontmatterOffset,
        opts.id,
        marks,
      )
      const island = compileClient(template, script, {
        hash,
        scopeAttr,
        styles,
        file: opts.id,
        fm,
        source,
        templateOffset,
        marks,
        scriptAt: marks && scripts.length === 1 ? scriptContentOffsets[0] : undefined,
        props: statorPropsType(frontmatter, template, scripts),
      })
      if (opts.stamp) {
        const pragma = contractPragma(opts.stamp.compiler)
        island.serverCode = `${pragma}\n${island.serverCode}`
        island.clientCode = `${pragma}\n${island.clientCode}`
      }
      if (!opts.sourceMap) return island
      const server = finalizeSourceMap(island.serverCode, source, opts.sourceMap.source)
      const client = finalizeSourceMap(island.clientCode, source, opts.sourceMap.source)
      return {
        ...island,
        serverCode: `${server.code}${inlineSourceMapComment(server.map)}\n`,
        map: server.map,
        clientCode: `${client.code}${inlineSourceMapComment(client.map)}\n`,
        clientMap: client.map,
      }
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
    marks,
  })
  const css = hasStyles ? scopeCss(styles.join('\n'), hash) : ''

  const fm = processFrontmatter(frontmatter, kind, source, frontmatterOffset, opts.id, marks)
  let serverCode =
    kind === 'route'
      ? emitRoute(fm, htmlExpr, meta)
      : emitComponent(fm, htmlExpr, meta, statorPropsType(frontmatter, template, scripts))
  if (opts.stamp) serverCode = `${contractPragma(opts.stamp.compiler)}\n${serverCode}`
  let map: SourceMapV3 | undefined
  if (opts.sourceMap) {
    ;({ code: serverCode, map } = finalizeSourceMap(serverCode, source, opts.sourceMap.source))
    serverCode += `${inlineSourceMapComment(map)}\n`
  }

  return {
    serverCode,
    ...(map ? { map } : {}),
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
  ctx: {
    hash: string
    scopeAttr?: string
    styles: string[]
    file?: string
    /** The island's processed server fence — empty parts when absent. */
    fm?: FrontmatterParts
    /** Original source, for located collision diagnostics. */
    source?: string
    /** Offset of the template body in `source`. */
    templateOffset?: number
    /** Drop source-map marks in both halves (see `source-map.ts`). */
    marks?: boolean
    /** Where the script starts in `source`, when it is mapped. */
    scriptAt?: number
    /** The shell's props type, as the `.d.ts` declares it. */
    props: PropsType
  },
): CompileResult {
  const classes = analyzeScriptClasses(script)
  const root = extractClientRoot(template, ctx)

  // Name-match validation (both directions, hyphen rule).
  const tags = new Set([root.tag])
  analyzeClient(script, tags, { file: ctx.file })

  const cls = classes.find((c) => pascalToKebab(c.name) === root.tag)

  // A fence binding sharing a name with a `use()` field is ambiguous by
  // construction (client wiring keys template identifiers on the use-field
  // set) — a located error, not a precedence rule.
  if (ctx.fm && cls) {
    const fenceNames = fenceBindingNames(ctx.fm)
    for (const field of cls.useFields.keys()) {
      if (fenceNames.has(field)) {
        throw new CompileError(
          `stator: "${field}" is both a fence binding and a use() field — the template ` +
            `couldn't tell the server value from the client machine. Rename one.`,
          ctx.source ? locAt(ctx.source, 0, ctx.file) : undefined,
        )
      }
    }
  }
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
    // The root's children, located in the source: located diagnostics, and
    // marks on the shell's expressions when mapping.
    source: ctx.source,
    templateOffset: root.innerOffset,
    marks: ctx.marks,
  })

  const css = ctx.styles.length
    ? scopeCss(ctx.styles.join('\n'), ctx.hash, { strategy: 'descendant', rootTag: root.tag })
    : ''

  // Server shell module: <tag {attrs}{scope}>{inner}</tag>.
  const attrDecl = `{ ${[...cls.staticAttrs].map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`
  const rootScope = ctx.scopeAttr ? ` data-s-${ctx.hash}` : ''
  const serverCode = [
    SHELL_PRIMITIVES_IMPORT,
    ...(ctx.props.needsReadResult ? [READ_RESULT_TYPE_IMPORT] : []),
    ...(ctx.fm?.hoisted ? [ctx.fm.hoisted] : []),
    '',
    `export default function (props: ${ctx.props.propsT} = {}) {`,
    // The fence body runs here — per shell render, server only, ahead of
    // the template so its bindings are in scope for the interpolations.
    ...(ctx.fm?.body ? [ctx.fm.body] : []),
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
    scriptAt: ctx.scriptAt,
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
/** The island root's own attributes: static only. The shell renders the root
 *  from the use site's props, so a dynamic value here has nothing to bind to —
 *  rather than silently dropping it, say so. */
function staticRootAttrs(
  tag: string,
  attrs: ts.JsxAttributes,
  sf: ts.SourceFile,
  at: (node: ts.Node) => DiagnosticLocation | undefined,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const attr of attrs.properties) {
    const isStatic =
      ts.isJsxAttribute(attr) &&
      !ts.isJsxNamespacedName(attr.name) &&
      (attr.initializer === undefined || ts.isStringLiteral(attr.initializer))
    if (!isStatic) {
      throw new CompileError(
        `stator: <${tag} ${attr.getText(sf)}> — attributes on an island's root must be static ` +
          `(a string literal or a bare boolean). The root is rendered by the shell from the use ` +
          `site's props; a dynamic value belongs on an inner element, or declare it with ` +
          `\`static attrs\` and pass it from the use site.`,
        at(attr),
      )
    }
    const name = attr.name.getText(sf)
    out[name] = attr.initializer === undefined ? true : (attr.initializer as ts.StringLiteral).text
  }
  return out
}

/** Parse a client template, returning the custom-element root tag, its inner
 *  source (its children), and the root's own static attributes. Enforces "root
 *  must be the custom element". */
function extractClientRoot(
  template: string,
  ctx: { file?: string; source?: string; templateOffset?: number },
): {
  tag: string
  inner: string
  /** Where `inner` starts in the source, when the source is known. */
  innerOffset?: number
  rootAttrs: Record<string, string | boolean>
} {
  const { file } = ctx
  const prefix = 'const __t = (<>'
  const wrapped = `${prefix}${template}</>);`
  const sf = ts.createSourceFile('t.tsx', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const at = (node: ts.Node): DiagnosticLocation | undefined =>
    ctx.source != null && ctx.templateOffset != null
      ? locAt(ctx.source, ctx.templateOffset + (node.getStart(sf) - prefix.length), file)
      : undefined
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
    return { tag, inner: '', rootAttrs: staticRootAttrs(tag, rootEl.attributes, sf, at) }
  }
  const el = rootEl as ts.JsxElement
  const tag = el.openingElement.tagName.getText(sf)
  requireCustomRoot(tag, file)
  const inner = wrapped.slice(el.openingElement.getEnd(), el.closingElement.getStart())
  const innerOffset =
    ctx.templateOffset != null
      ? ctx.templateOffset + (el.openingElement.getEnd() - prefix.length)
      : undefined
  return {
    tag,
    inner,
    innerOffset,
    rootAttrs: staticRootAttrs(tag, el.openingElement.attributes, sf, at),
  }
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
 * errors. Route: `Stator.reads([A,B])` RHS → `[__ctx[A.name] as …, __ctx[B.name] as …]`
 * (and `[A,B]` captured for the `reads:` config); `Stator.request` → `__req`;
 * `Stator.response` → `__ctx.response`. `Stator.props` is an error.
 */
function processFrontmatter(
  fm: string,
  kind: 'route' | 'component' | 'island',
  source: string,
  fmStart: number,
  file?: string,
  marks = false,
): FrontmatterParts {
  const pragmas = parsePragmas(fm, kind, source, fmStart, file)
  if (!fm.trim()) return { hoisted: '', body: '', reads: [], pragmas }

  const sf = ts.createSourceFile('fm.ts', fm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hoisted: string[] = []
  const body: string[] = []
  let propsType: string | undefined
  const reads: string[] = []

  const locInFm = (node: ts.Node): DiagnosticLocation =>
    locAt(source, fmStart + node.getStart(sf), file)

  // The fence is plain TypeScript (ScriptKind.TS): a bare `<p>` lexes as an
  // old-style type assertion, so JSX here would otherwise surface only as
  // esbuild's `Expected ")" but found "return"` on the emitted module, while
  // the editor's TSX model accepts it. Report syntax errors here, with the one
  // targeted hint for that shape.
  const syntax = parseDiagnosticsOf(sf)
  if (syntax.length > 0) {
    const jsx = findJsxLikeAssertion(sf)
    if (jsx) {
      throw new CompileError(
        "stator: JSX isn't allowed in frontmatter — it's plain TypeScript. Markup belongs in " +
          'the template (use when()/match() for conditional content); a different page for a ' +
          'not-found case cascades to routes/404.stator.',
        locInFm(jsx),
      )
    }
    const d = syntax[0]!
    throw new CompileError(
      `stator: frontmatter syntax error — ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      locAt(source, fmStart + d.start, file),
    )
  }

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      const text = stmt.getText(sf)
      hoisted.push(marks ? markVerbatim(text, fmStart + stmt.getStart(sf)) : text)
      continue
    }

    const stmtStart = stmt.getStart(sf)
    const repls: Array<[start: number, end: number, replacement: string]> = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isStatorCall(n, 'props')) {
        if (kind === 'island') {
          throw new CompileError(
            "stator: Stator.props() is not available in an island's fence — island props are " +
              'declared by `static attrs` on the element class, and richer values arrive ' +
              'through the hydrate pattern (the shell renders with the props of its use site).',
            locInFm(n),
          )
        }
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
        // Typed as the editor types them, so compiled output a package ships
        // typechecks in the consuming app. The cast is erased at runtime.
        const handle = (el: ts.Expression, id: string): string =>
          ts.isIdentifier(el) || ts.isPropertyAccessExpression(el)
            ? `__ctx[${id}.name] as __InstanceOf<typeof ${id}>`
            : `__ctx[${id}.name]`
        const bound = `[${arg.elements.map((el, i) => handle(el, ids[i]!)).join(', ')}]`
        repls.push([n.getStart(sf), n.getEnd(), bound])
        return
      }
      if (ts.isCallExpression(n) && isStatorCall(n, 'forwarded')) {
        if (kind === 'island') {
          throw new CompileError(
            "stator: Stator.forwarded() is not available in an island's fence.",
            locInFm(n),
          )
        }
        if (kind === 'route') {
          throw new CompileError(
            'stator: Stator.forwarded() is only available in a component — it reads a directive ' +
              'forwarded from a parent (`<Child on:click={h}/>`), and a route has no parent.',
            locInFm(n),
          )
        }
        const arg = n.arguments[0]
        if (!arg) {
          throw new CompileError(
            "stator: Stator.forwarded(name) takes a directive name, e.g. Stator.forwarded('on:click')",
            locInFm(n),
          )
        }
        // The parent packs component-level directives into a reserved `$directives`
        // prop; this reads one back so the author can re-attach it where they like.
        repls.push([n.getStart(sf), n.getEnd(), `props.$directives?.[${arg.getText(sf)}]`])
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
    const text = splice(stmt.getText(sf), stmtStart, repls, marks ? (p) => fmStart + p : undefined)
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

/** Top-level names a fence declares — imports (default/named/namespace),
 *  consts/lets, functions, classes — for the fence-vs-use()-field collision
 *  check. Parsed from the processed parts (hoisted + body). */
function fenceBindingNames(fm: FrontmatterParts): Set<string> {
  const names = new Set<string>()
  const sf = ts.createSourceFile(
    'fence.ts',
    stripMarks(`${fm.hoisted}\n${fm.body}`),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) names.add(n.text)
    else for (const el of n.elements) if (ts.isBindingElement(el)) bind(el.name)
  }
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause
      if (c.name) names.add(c.name.text)
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) names.add(c.namedBindings.name.text)
        else for (const s of c.namedBindings.elements) names.add(s.name.text)
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) bind(d.name)
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text)
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      names.add(stmt.name.text)
    }
  }
  return names
}

function emitComponent(
  fm: FrontmatterParts,
  htmlExpr: string,
  meta: LowerMeta,
  props: PropsType,
): string {
  // A component without declared props still takes the call's empty props object.
  const param =
    fm.propsType || meta.usesChildren ? `props: ${props.propsT}` : `_props: ${props.propsT} = {}`

  const lines = [PRIMITIVES_IMPORT]
  if (props.needsReadResult) lines.push(READ_RESULT_TYPE_IMPORT)
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
  if (fm.reads.length > 0) {
    lines.push("import type { InstanceOf as __InstanceOf } from '@statorjs/stator/template'")
  }
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
  kind: 'route' | 'component' | 'island',
  source: string,
  fmStart: number,
  file?: string,
): Set<string> {
  const out = new Set<string>()
  const re = /\/\/\s*@stator\s+(\S+)/g
  for (const m of fm.matchAll(re)) {
    const flag = m[1]!
    if (!VALID_PRAGMAS.has(flag)) {
      throw new CompileError(
        `stator: unknown pragma "// @stator ${flag}". Known flags: ${[...VALID_PRAGMAS].join(', ')}.`,
        locAt(source, fmStart + m.index, file),
      )
    }
    if (kind !== 'route') {
      throw new CompileError(
        `stator: "// @stator ${flag}" is only valid in a route page, not a component.`,
        locAt(source, fmStart + m.index, file),
      )
    }
    out.add(flag)
  }
  return out
}

function requireRoute(
  what: string,
  kind: 'route' | 'component' | 'island',
  loc: DiagnosticLocation,
): void {
  if (kind !== 'route') {
    throw new CompileError(
      `stator: ${what} is only available in a route page, not a component. ` +
        `Read it in the route and pass the value down as a prop.`,
      loc,
    )
  }
}

/** The node a `<p>` or `<NotFound>` becomes when parsed as TS: a type assertion
 *  whose type is a bare identifier reference. A generic arrow (`<T>(a: T) => a`)
 *  is not one, so it stays legal. */
function findJsxLikeAssertion(sf: ts.SourceFile): ts.TypeAssertion | undefined {
  let found: ts.TypeAssertion | undefined
  const visit = (n: ts.Node): void => {
    if (found) return
    if (
      ts.isTypeAssertionExpression(n) &&
      ts.isTypeReferenceNode(n.type) &&
      ts.isIdentifier(n.type.typeName) &&
      !n.type.typeArguments
    ) {
      found = n
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

function isStatorCall(call: ts.CallExpression, member: string): boolean {
  return ts.isPropertyAccessExpression(call.expression) && isStatorMember(call.expression, member)
}

function isStatorMember(e: ts.PropertyAccessExpression, member: string): boolean {
  return ts.isIdentifier(e.expression) && e.expression.text === 'Stator' && e.name.text === member
}
