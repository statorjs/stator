import { statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { scanRegions } from '../compiler/split.ts'

/**
 * The one static import scanner the build reads module graphs with.
 *
 * Parsed with the TypeScript API, not matched as text: an import shown in a
 * comment or spelled inside a string is not in the tree, so it is never read as
 * a dependency. A `.stator` file is scanned through its frontmatter and
 * `<script>` regions, with offsets into the whole file.
 */

export interface ModuleImport {
  /** The specifier as written. */
  spec: string
  /** Offsets of the whole statement (or `import()` call) in the file's text,
   *  leading trivia excluded. */
  start: number
  end: number
  kind: 'import' | 'export' | 'import-equals' | 'dynamic'
  /** `import type …` / `export type … from`. */
  typeOnly: boolean
  /** An `ImportDeclaration`'s default binding. */
  defaultName?: string
  /** Named bindings, `imported as local` (`export { a as b } from` lists `a`
   *  as imported, `b` as local), each marked when it is `type`-only. */
  named: Array<{ imported: string; local: string; typeOnly: boolean }>
  /** `import * as ns` / `export * as ns from`. */
  namespace?: string
  /** `export * from`. */
  exportStar?: boolean
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Parse module text as TypeScript (or JS/TSX/JSX by extension). */
export function parseModule(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
}

/** The static imports and `export … from`s of a parsed module, plus
 *  `import('literal')` calls. `offset` is added to every position. */
export function importsIn(sf: ts.SourceFile, offset = 0): ModuleImport[] {
  const out: ModuleImport[] = []
  const at = (node: ts.Node) => ({
    start: node.getStart(sf) + offset,
    end: node.getEnd() + offset,
  })
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const named: ModuleImport['named'] = []
      let namespace: string | undefined
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespace = bindings.name.text
      else if (bindings) {
        for (const el of bindings.elements) {
          named.push({
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            typeOnly: el.isTypeOnly,
          })
        }
      }
      out.push({
        spec: node.moduleSpecifier.text,
        ...at(node),
        kind: 'import',
        typeOnly: clause?.isTypeOnly ?? false,
        ...(clause?.name ? { defaultName: clause.name.text } : {}),
        named,
        ...(namespace ? { namespace } : {}),
      })
      return
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const named: ModuleImport['named'] = []
      let namespace: string | undefined
      const clause = node.exportClause
      if (clause && ts.isNamespaceExport(clause)) namespace = clause.name.text
      else if (clause) {
        for (const el of clause.elements) {
          named.push({
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            typeOnly: el.isTypeOnly,
          })
        }
      }
      out.push({
        spec: node.moduleSpecifier.text,
        ...at(node),
        kind: 'export',
        typeOnly: node.isTypeOnly,
        named,
        ...(namespace ? { namespace } : {}),
        ...(clause ? {} : { exportStar: true }),
      })
      return
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      out.push({
        spec: node.moduleReference.expression.text,
        ...at(node),
        kind: 'import-equals',
        typeOnly: node.isTypeOnly,
        named: [],
      })
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteralLike(arg)) {
        out.push({ spec: arg.text, ...at(node), kind: 'dynamic', typeOnly: false, named: [] })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return out
}

/** A file's imports, read from its text. A `.stator` file contributes its
 *  frontmatter and `<script>` regions. */
export function scanImports(text: string, file: string): ModuleImport[] {
  if (!file.endsWith('.stator')) return importsIn(parseModule(text, file))
  const regions = scanRegions(text)
  const out: ModuleImport[] = []
  for (const region of [
    ...(regions.frontmatter ? [regions.frontmatter] : []),
    ...regions.scripts,
  ]) {
    out.push(...importsIn(parseModule(region.content, `${file}.ts`), region.contentOffset))
  }
  return out
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

/** The file a relative specifier's absolute `base` names: `base` itself, or
 *  with `.ts`, `.js`, `/index.ts`, `/index.js`, in that order. */
export function probeModule(base: string): string | undefined {
  return [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')].find(
    isFile,
  )
}
