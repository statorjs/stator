import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { splitStator } from './split.ts'

/**
 * Lightweight analysis of a `.stator` file's *public composition surface* — the
 * named `<children name="x"/>` regions it declares — without a full compile.
 * Used for cross-file named-child validation: when compiling a caller, we
 * resolve each `<Component>` to its file and check every `child="x"` against the
 * callee's declared regions.
 *
 * Cheap and side-effect-free: parse the template body, collect `<children
 * name=…>` literals. (`default` is always implicitly available.)
 */
export function declaredRegions(source: string): Set<string> {
  const { template } = splitStator(source)
  const sf = ts.createSourceFile(
    'regions.tsx',
    `const __t = (<>${template.replace(/^\s*<!doctype[^>]*>/i, '')}</>);`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const regions = new Set<string>()
  const visit = (node: ts.Node): void => {
    const tagName = ts.isJsxElement(node)
      ? node.openingElement.tagName.getText(sf)
      : ts.isJsxSelfClosingElement(node)
        ? node.tagName.getText(sf)
        : undefined
    if (tagName === 'children') {
      const attrs = ts.isJsxElement(node)
        ? node.openingElement.attributes
        : (node as ts.JsxSelfClosingElement).attributes
      for (const attr of attrs.properties) {
        if (
          ts.isJsxAttribute(attr) &&
          !ts.isJsxNamespacedName(attr.name) &&
          attr.name.getText(sf) === 'name' &&
          attr.initializer &&
          ts.isStringLiteral(attr.initializer)
        ) {
          regions.add(attr.initializer.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return regions
}

/**
 * Map a component identifier used in a file to the `.stator` file it's imported
 * from, by reading the file's frontmatter import declarations. Returns the
 * resolved import specifier (e.g. `'./customer-layout.stator'`) or null if the
 * identifier isn't a default import of a `.stator` module.
 */
export function componentImportSpecifier(
  frontmatter: string,
  componentName: string,
): string | null {
  const sf = ts.createSourceFile(
    'fm.ts',
    frontmatter,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name && clause.name.text === componentName) {
      const spec = stmt.moduleSpecifier
      if (ts.isStringLiteral(spec) && spec.text.endsWith('.stator')) return spec.text
    }
  }
  return null
}

/**
 * Build a region resolver for a file: maps a component identifier used in
 * `file` to the named regions its imported `.stator` declares, so `compile()`
 * can reject a `child="x"` the callee never declares. Reads sibling files
 * synchronously (resolution happens mid-compile). Returns null when the
 * identifier isn't a `.stator` default import or the file can't be read.
 *
 * Shared by every compile path — the Vite plugin, `buildApp`, and the native
 * dev loader — so the check is identical in dev and prod.
 */
export function regionResolverFor(
  file: string,
  source: string,
): (componentName: string) => Set<string> | null {
  const { frontmatter } = splitStator(source)
  return (componentName) => {
    const spec = componentImportSpecifier(frontmatter, componentName)
    if (!spec) return null
    const target = spec.startsWith('.') ? resolve(dirname(file), spec) : null
    if (!target) return null
    try {
      return declaredRegions(readFileSync(target, 'utf8'))
    } catch {
      return null
    }
  }
}
