import ts from 'typescript'

/**
 * Lower a `.stator` JSX template body to an `html\`…\`` tagged-template
 * expression — the exact shape the existing runtime parser already consumes.
 * This is the MVP's core move: the compiler is a source-to-source transform, not
 * a new renderer. Compile-time slot analysis is a later optimization.
 *
 * The body is parsed with the TypeScript JSX parser. Directives ride in as JSX
 * *namespaced attributes* (`on:click`, `class:list`, `style:list`), which TS
 * parses natively. Nested JSX inside callback expressions (`each`/`when`/`match`
 * bodies) is lowered recursively to its own `html\`…\``.
 */

export class CompileError extends Error {}

/** Returns the `html\`…\`` expression for the whole template body. */
export function lowerTemplate(template: string): string {
  const wrapped = `const __t = (<>${template}</>);`
  const sf = ts.createSourceFile(
    'template.tsx',
    wrapped,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  )

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

  return 'html`' + contentOfChildren(fragment.children, sf) + '`'
}

function contentOfChildren(children: ts.NodeArray<ts.JsxChild>, sf: ts.SourceFile): string {
  let out = ''
  for (const child of children) out += contentOfChild(child, sf)
  return out
}

function contentOfChild(node: ts.JsxChild, sf: ts.SourceFile): string {
  if (ts.isJsxText(node)) return escapeText(node.getText(sf))
  if (ts.isJsxExpression(node)) {
    if (!node.expression) return '' // `{}` or `{/* comment */}`
    return '${' + lowerExprText(node.expression, sf) + '}'
  }
  if (ts.isJsxElement(node)) {
    const tag = node.openingElement.tagName.getText(sf)
    return `<${tag}${lowerAttributes(node.openingElement.attributes, sf)}>${contentOfChildren(node.children, sf)}</${tag}>`
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return `<${node.tagName.getText(sf)}${lowerAttributes(node.attributes, sf)} />`
  }
  if (ts.isJsxFragment(node)) return contentOfChildren(node.children, sf)
  throw new CompileError(
    `stator: unsupported template node: ${ts.SyntaxKind[(node as ts.Node).kind]}`,
  )
}

/**
 * Lower an arbitrary expression to source text with any *outermost* JSX
 * descendants replaced by their own `html\`…\`` lowering. Handles callback
 * bodies like `each(items, (i) => <li>{i.name}</li>)`.
 */
function lowerExprText(expr: ts.Expression, sf: ts.SourceFile): string {
  if (
    ts.isJsxElement(expr) ||
    ts.isJsxSelfClosingElement(expr) ||
    ts.isJsxFragment(expr)
  ) {
    return 'html`' + contentOfChild(expr as unknown as ts.JsxChild, sf) + '`'
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
        'html`' + contentOfChild(n as unknown as ts.JsxChild, sf) + '`',
      ])
      return // don't descend; contentOfChild handles this node's internals
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(expr, visit)

  repls.sort((a, b) => b[0] - a[0]) // splice right-to-left to keep offsets valid
  for (const [start, end, replacement] of repls) {
    text = text.slice(0, start - exprStart) + replacement + text.slice(end - exprStart)
  }
  return text
}

function lowerAttributes(attrs: ts.JsxAttributes, sf: ts.SourceFile): string {
  let out = ''
  for (const attr of attrs.properties) {
    if (ts.isJsxSpreadAttribute(attr)) {
      throw new CompileError('stator: spread attributes ({...x}) are not supported')
    }
    out += ' ' + lowerAttribute(attr, sf)
  }
  return out
}

function lowerAttribute(attr: ts.JsxAttribute, sf: ts.SourceFile): string {
  if (ts.isJsxNamespacedName(attr.name)) {
    const ns = attr.name.namespace.text
    const name = attr.name.name.text
    const value = attrExpr(attr, sf)
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
  return `${name}="\${${attrExpr(attr, sf)}}"`
}

function attrExpr(attr: ts.JsxAttribute, sf: ts.SourceFile): string {
  const init = attr.initializer
  if (init && ts.isJsxExpression(init) && init.expression) {
    return lowerExprText(init.expression, sf)
  }
  return ''
}

function requireValue(value: string, directive: string): string {
  if (!value) throw new CompileError(`stator: ${directive} requires a value ({...})`)
  return value
}

/** Escape literal template text so it round-trips inside a `\`…\`` literal. */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}
