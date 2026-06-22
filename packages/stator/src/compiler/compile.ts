import ts from 'typescript'
import { splitStator } from './split.ts'
import { lowerTemplate, type LowerMeta } from './lower.ts'
import { scopeHash } from './hash.ts'
import { scopeCss } from './styles.ts'
import { CompileError, locAt, type DiagnosticLocation } from './diagnostics.ts'

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
  /** The server render module source. */
  serverCode: string
  /** Per-component scope hash (the `data-s-<hash>` marker uses it). */
  scopeHash: string
  /** Scoped CSS, ready for the Vite CSS pipeline. Empty when there's no
   *  `<style>`. */
  css: string
  /** Client `<script>` regions (Phase 3b). */
  scripts: string[]
}

const PRIMITIVES_IMPORT =
  "import { html, read, each, when, match, on, classList, styleList } from '@statorjs/stator/template'"

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
  const { frontmatter, template, styles, scripts, templateOffset } = splitStator(source)
  const kind = opts.kind ?? 'component'

  const hasStyles = styles.length > 0
  const hash = scopeHash(opts.id ?? source)
  const scopeAttr = hasStyles ? `data-s-${hash}` : undefined

  const meta: LowerMeta = { usesChildren: false, regions: new Set(), components: new Set(), customElements: new Set(), refs: new Set() }
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
    kind === 'route'
      ? emitRoute(fm, htmlExpr, meta)
      : emitComponent(fm, htmlExpr, meta)

  return { serverCode, scopeHash: hash, css, scripts }
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
        const bound = '[' + ids.map((id) => `__ctx[${id}.name]`).join(', ') + ']'
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
    body.push('  ' + text)
  }

  return { hoisted: hoisted.join('\n'), body: body.join('\n'), propsType, reads, pragmas }
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
  return lines.join('\n') + '\n'
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
  return lines.join('\n') + '\n'
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
  let m: RegExpExecArray | null
  while ((m = re.exec(fm)) !== null) {
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
