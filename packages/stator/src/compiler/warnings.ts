import ts from 'typescript'
import { type DiagnosticLocation, locAt } from './diagnostics.ts'
import { scanRegions } from './split.ts'
import { scanTemplate } from './template-scan.ts'

/**
 * Compiler warnings: located findings that don't stop a compile. `stator
 * check` prints them and stays green; the language server shows them as
 * warning squiggles. Separate from `compile()` (which throws `CompileError`)
 * so neither caller has to change how it handles a failed compile.
 */

export interface CompileWarning {
  message: string
  /** Offset of the finding in the original `.stator` source. */
  offset: number
  loc: DiagnosticLocation
}

export const RAW_SCRIPT_WARNING =
  "<script> built as a string and passed to raw() — it is not processed or bundled, and interpolated values aren't escaped for script content. Use a component (<JsonLd>, or a TS function component like it) for data blocks, or a top-level <script> for client code."

const SCRIPT_OPEN_RE = /<script[\s>/]/i

/** Every warning for a `.stator` source, in source order. */
export function compileWarnings(source: string, file?: string): CompileWarning[] {
  const offsets: number[] = []
  const regions = scanRegions(source)
  if (regions.frontmatter) {
    rawScriptLiterals(regions.frontmatter.content, regions.frontmatter.contentOffset, offsets)
  }
  const body = regions.template
  const scan = scanTemplate(source, body.contentOffset, body.contentOffset + body.content.length)
  for (const { start, end } of scan.expressions) {
    // Parenthesised so an object literal or a bare JSX element parses as an
    // expression; the `(` shifts every position by one.
    rawScriptLiterals(`(${source.slice(start, end)})`, start - 1, offsets)
  }
  return offsets
    .sort((a, b) => a - b)
    .map((offset) => ({ message: RAW_SCRIPT_WARNING, offset, loc: locAt(source, offset, file) }))
}

/** Push the offset of each string or template literal containing an opening
 *  `<script` tag that is passed straight to `raw()`. A variable argument is
 *  the sanctioned escape hatch and isn't flagged; a plain string is escaped on
 *  output, so it isn't either. */
function rawScriptLiterals(code: string, base: number, out: number[]): void {
  const sf = ts.createSourceFile('w.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'raw'
    ) {
      const arg = node.arguments[0]
      if (
        arg &&
        (ts.isStringLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg) ||
          ts.isTemplateExpression(arg)) &&
        SCRIPT_OPEN_RE.test(arg.getText(sf))
      ) {
        out.push(base + arg.getStart(sf))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
