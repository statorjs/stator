import ts from 'typescript'
import { splitStator } from './split.ts'
import { lowerTemplate } from './lower.ts'

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
  /** Scoped CSS (later stage). */
  styles: string[]
  /** Client `<script>` regions (Phase 3b). */
  scripts: string[]
}

const PRIMITIVES_IMPORT =
  "import { html, read, each, when, match, on, classList, styleList } from '@statorjs/stator/template'"

export function compile(source: string): CompileResult {
  const { frontmatter, template, styles, scripts } = splitStator(source)
  const htmlExpr = lowerTemplate(template)
  const { hoisted, body, propsType } = processFrontmatter(frontmatter)

  const param = propsType ? `props: ${propsType}` : ''
  const lines = [PRIMITIVES_IMPORT]
  if (hoisted) lines.push(hoisted)
  lines.push('')
  lines.push(`export default function (${param}) {`)
  if (body) lines.push(body)
  lines.push(`  return ${htmlExpr}`)
  lines.push('}')

  return { serverCode: lines.join('\n') + '\n', styles, scripts }
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
