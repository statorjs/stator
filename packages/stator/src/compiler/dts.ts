import ts from 'typescript'
import { splitStator } from './split.ts'

/**
 * Generate a `<name>.stator.d.ts` for a component, giving callers real prop
 * types. TS resolves `import X from './x.stator'` to this specific `.d.ts` (which
 * beats the `*.stator` ambient wildcard), so `<X prop={...}/>` is type-checked.
 *
 * The `.d.ts` carries the component's frontmatter type imports (so the props
 * type's references resolve) plus the default-export signature derived from
 * `Stator.props<P>()` (+ a loose `children` bag when the body uses `<children>`).
 *
 * Routes don't get a `.d.ts` — they export `GET`, not a callable render
 * function — so `generateDts` returns null for `kind: 'route'`.
 */
export function generateDts(
  source: string,
  opts: { kind?: 'route' | 'component' } = {},
): string | null {
  if ((opts.kind ?? 'component') === 'route') return null

  const { frontmatter, template } = splitStator(source)
  const { hoisted, propsType } = extractFrontmatterTypes(frontmatter)
  const propsT = componentPropsType(propsType, template)

  const lines = ["import type { HtmlFragment } from '@statorjs/stator/template'"]
  if (hoisted) lines.push(hoisted)
  lines.push('')
  lines.push(`declare const _default: (props: ${propsT}) => HtmlFragment`)
  lines.push('export default _default')
  return `${lines.join('\n')}\n`
}

/**
 * The full props type for a component's public signature: the
 * `Stator.props<P>()` type argument (verbatim source text — inline literal or
 * a named reference), widened with a children bag when the body renders
 * `<children>`. A component that declares no props accepts none
 * (`Record<string, never>`). Shared by the `.d.ts` generator (tsc) and the
 * language-server virtual emit (editor), so the two can't disagree.
 */
export function componentPropsType(propsType: string | undefined, template: string): string {
  const usesChildren = /<children[\s/>]/.test(template)
  if (propsType) return usesChildren ? `${propsType} & { children?: any }` : propsType
  return usesChildren ? '{ children?: any }' : 'Record<string, never>'
}

/** Collect the import/type/interface declarations from frontmatter (for the
 *  `.d.ts` to re-state) and the `Stator.props<P>()` type argument. */
export function extractFrontmatterTypes(fm: string): {
  hoisted: string
  propsType?: string
} {
  if (!fm.trim()) return { hoisted: '' }
  const sf = ts.createSourceFile('fm.ts', fm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hoisted: string[] = []
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
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'Stator' &&
        n.expression.name.text === 'props' &&
        n.typeArguments &&
        n.typeArguments.length > 0
      ) {
        propsType = n.typeArguments[0]!.getText(sf)
        return
      }
      ts.forEachChild(n, visit)
    }
    visit(stmt)
  }

  return { hoisted: hoisted.join('\n'), propsType }
}
