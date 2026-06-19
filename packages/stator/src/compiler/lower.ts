import ts from 'typescript'

/**
 * Lower a `.stator` JSX template body to an `html\`…\`` tagged-template
 * expression — the exact shape the existing runtime parser already consumes.
 * This is the MVP's core move: the compiler is a source-to-source transform, not
 * a new renderer.
 *
 * The body is parsed with the TypeScript JSX parser. Directives ride in as JSX
 * *namespaced attributes* (`on:click`, `class:list`, `style:list`). Nested JSX
 * inside callback expressions (`each`/`when`/`match` bodies) is lowered
 * recursively to its own `html\`…\``.
 *
 * When `scopeAttr` is set, every rendered element gets that attribute appended
 * (`data-s-<hash>`) — the marker the scoped-style selector rewrite targets.
 */

export class CompileError extends Error {}

export interface LowerOptions {
  /** Scope marker attribute, e.g. `data-s-a1b2c3d4`. Injected on every element. */
  scopeAttr?: string
}

export function lowerTemplate(template: string, opts: LowerOptions = {}): string {
  const wrapped = `const __t = (<>${template}</>);`
  const sf = ts.createSourceFile(
    'template.tsx',
    wrapped,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  )
  const scopeSuffix = opts.scopeAttr ? ` ${opts.scopeAttr}` : ''

  let fragment: ts.JsxFragment | undefined
  const find = (node: ts.Node): void => {
    if (ts.isJsxFragment(node)) {
      fragment = node
      return
    }
    ts.forEachChild(node, find)
  }
  find(sf)
  if (!fragment) throw new CompileError('stator: could not parse template body as JSX')

  const contentOfChildren = (children: ts.NodeArray<ts.JsxChild>): string => {
    let out = ''
    for (const child of children) out += contentOfChild(child)
    return out
  }

  const contentOfChild = (node: ts.JsxChild): string => {
    if (ts.isJsxText(node)) return escapeText(node.getText(sf))
    if (ts.isJsxExpression(node)) {
      if (!node.expression) return '' // `{}` or `{/* comment */}`
      return '${' + lowerExprText(node.expression) + '}'
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf)
      const attrs = lowerAttributes(node.openingElement.attributes)
      return `<${tag}${attrs}${scopeSuffix}>${contentOfChildren(node.children)}</${tag}>`
    }
    if (ts.isJsxSelfClosingElement(node)) {
      return `<${node.tagName.getText(sf)}${lowerAttributes(node.attributes)}${scopeSuffix} />`
    }
    if (ts.isJsxFragment(node)) return contentOfChildren(node.children)
    throw new CompileError(
      `stator: unsupported template node: ${ts.SyntaxKind[(node as ts.Node).kind]}`,
    )
  }

  const lowerExprText = (expr: ts.Expression): string => {
    if (
      ts.isJsxElement(expr) ||
      ts.isJsxSelfClosingElement(expr) ||
      ts.isJsxFragment(expr)
    ) {
      return 'html`' + contentOfChild(expr as unknown as ts.JsxChild) + '`'
    }

    const exprStart = expr.getStart(sf)
    let text = expr.getText(sf)
    const repls: Array<[start: number, end: number, replacement: string]> = []
    const visit = (n: ts.Node): void => {
      if (
        n !== expr &&
        (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
      ) {
        repls.push([
          n.getStart(sf),
          n.getEnd(),
          'html`' + contentOfChild(n as unknown as ts.JsxChild) + '`',
        ])
        return // contentOfChild handles this node's internals
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(expr, visit)

    repls.sort((a, b) => b[0] - a[0])
    for (const [start, end, replacement] of repls) {
      text = text.slice(0, start - exprStart) + replacement + text.slice(end - exprStart)
    }
    return text
  }

  const lowerAttributes = (attrs: ts.JsxAttributes): string => {
    let out = ''
    for (const attr of attrs.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        throw new CompileError('stator: spread attributes ({...x}) are not supported')
      }
      out += ' ' + lowerAttribute(attr)
    }
    return out
  }

  const lowerAttribute = (attr: ts.JsxAttribute): string => {
    if (ts.isJsxNamespacedName(attr.name)) {
      const ns = attr.name.namespace.text
      const name = attr.name.name.text
      const value = attrExpr(attr)
      if (ns === 'on') {
        if (!value) throw new CompileError(`stator: on:${name} requires a handler ({...})`)
        return '${' + `on(${JSON.stringify(name)}, ${value})` + '}'
      }
      if (ns === 'class' && name === 'list') {
        return '${' + `classList(${requireValue(value, 'class:list')})` + '}'
      }
      if (ns === 'style' && name === 'list') {
        return '${' + `styleList(${requireValue(value, 'style:list')})` + '}'
      }
      throw new CompileError(`stator: directive "${ns}:${name}" is not supported yet (Phase 3b)`)
    }

    const name = attr.name.getText(sf)
    if (!attr.initializer) return name // boolean attribute
    if (ts.isStringLiteral(attr.initializer)) {
      return `${name}=${JSON.stringify(attr.initializer.text)}`
    }
    return `${name}="\${${attrExpr(attr)}}"`
  }

  const attrExpr = (attr: ts.JsxAttribute): string => {
    const init = attr.initializer
    if (init && ts.isJsxExpression(init) && init.expression) {
      return lowerExprText(init.expression)
    }
    return ''
  }

  return 'html`' + contentOfChildren(fragment.children) + '`'
}

function requireValue(value: string, directive: string): string {
  if (!value) throw new CompileError(`stator: ${directive} requires a value ({...})`)
  return value
}

/** Escape literal template text so it round-trips inside a `\`…\`` literal. */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}
