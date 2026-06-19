import ts from 'typescript'
import { splitStator } from './split.ts'
import { lowerTemplate } from './lower.ts'
import { scopeHash } from './hash.ts'
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
   *  hash is stable across edits to unrelated files; falls back to the source. */
  id?: string
}

export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  const { frontmatter, template, styles, scripts } = splitStator(source)

  const hasStyles = styles.length > 0
  const hash = scopeHash(opts.id ?? source)
  const scopeAttr = hasStyles ? `data-s-${hash}` : undefined

  const htmlExpr = lowerTemplate(template, { scopeAttr })
  const css = hasStyles ? scopeCss(styles.join('\n'), hash) : ''
  const { hoisted, body, propsType } = processFrontmatter(frontmatter)

  const param = propsType ? `props: ${propsType}` : ''
  const lines = [PRIMITIVES_IMPORT]
  if (hoisted) lines.push(hoisted)
  lines.push('')
  lines.push(`export default function (${param}) {`)
  if (body) lines.push(body)
  lines.push(`  return ${htmlExpr}`)
  lines.push('}')

  return { serverCode: lines.join('\n') + '\n', scopeHash: hash, css, scripts }
}

interface FrontmatterParts {
  hoisted: string
  body: string
  propsType?: string
}

function processFrontmatter(fm: string): FrontmatterParts {
  if (!fm.trim()) return { hoisted: '', body: '' }

  const sf = ts.createSourceFile('fm.ts', fm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hoisted: string[] = []
  const body: string[] = []
  let propsType: string | undefined

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      hoisted.push(stmt.getText(sf))
      continue
    }

    // Body statement — splice out any `Stator.props<P>()` call, capturing P.
    const stmtStart = stmt.getStart(sf)
    let text = stmt.getText(sf)
    const repls: Array<[start: number, end: number, replacement: string]> = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isStatorProps(n)) {
        if (n.typeArguments && n.typeArguments.length > 0) {
          propsType = n.typeArguments[0]!.getText(sf)
        }
        repls.push([n.getStart(sf), n.getEnd(), 'props'])
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

  return { hoisted: hoisted.join('\n'), body: body.join('\n'), propsType }
}

function isStatorProps(call: ts.CallExpression): boolean {
  const e = call.expression
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'Stator' &&
    e.name.text === 'props'
  )
}
