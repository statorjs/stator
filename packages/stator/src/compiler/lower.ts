import ts from 'typescript'
import { CompileError, locAt, type DiagnosticLocation } from './diagnostics.ts'

export { CompileError } from './diagnostics.ts'

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

const WRAP_PREFIX_LEN = 'const __t = (<>'.length

export interface LowerOptions {
  /** Scope marker attribute, e.g. `data-s-a1b2c3d4`. Injected on every element. */
  scopeAttr?: string
  /** Original `.stator` source — enables located diagnostics. */
  source?: string
  /** Character offset in `source` where the template body begins. */
  templateOffset?: number
  /** File path, for diagnostics. */
  file?: string
}

export function lowerTemplate(template: string, opts: LowerOptions = {}): string {
  // A leading `<!doctype …>` isn't valid JSX — strip it before parsing and
  // prepend it verbatim to the emitted template (it has no `$`/backtick to escape).
  let doctype = ''
  let doctypeLen = 0
  const doctypeMatch = template.match(/^\s*<!doctype[^>]*>/i)
  if (doctypeMatch) {
    doctype = doctypeMatch[0].trim()
    doctypeLen = doctypeMatch[0].length
    template = template.slice(doctypeLen)
  }

  const wrapped = `const __t = (<>${template}</>);`
  const sf = ts.createSourceFile(
    'template.tsx',
    wrapped,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  )
  const scopeSuffix = opts.scopeAttr ? ` ${opts.scopeAttr}` : ''

  // Map a node in the wrapped template back to a location in the original
  // `.stator` source (when source-mapping context was provided).
  const loc = (node: ts.Node): DiagnosticLocation | undefined => {
    if (opts.source == null || opts.templateOffset == null) return undefined
    const orig = opts.templateOffset + doctypeLen + (node.getStart(sf) - WRAP_PREFIX_LEN)
    return locAt(opts.source, orig, opts.file)
  }

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
      if (isComponentTag(tag)) {
        return '${' + lowerComponent(tag, node.openingElement.attributes, node.children) + '}'
      }
      const attrs = lowerAttributes(node.openingElement.attributes)
      return `<${tag}${attrs}${scopeSuffix}>${contentOfChildren(node.children)}</${tag}>`
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf)
      if (isComponentTag(tag)) {
        return '${' + lowerComponent(tag, node.attributes, undefined) + '}'
      }
      return `<${tag}${lowerAttributes(node.attributes)}${scopeSuffix} />`
    }
    if (ts.isJsxFragment(node)) return contentOfChildren(node.children)
    throw new CompileError(
      `stator: unsupported template node: ${ts.SyntaxKind[(node as ts.Node).kind]}`,
      loc(node as ts.Node),
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
        throw new CompileError(
          'stator: spread attributes ({...x}) are not supported',
          loc(attr),
        )
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
      const requireValue = (dir: string): string => {
        if (!value) throw new CompileError(`stator: ${dir} requires a value ({...})`, loc(attr))
        return value
      }
      if (ns === 'on') {
        if (!value) {
          throw new CompileError(`stator: on:${name} requires a handler ({...})`, loc(attr))
        }
        return '${' + `on(${JSON.stringify(name)}, ${value})` + '}'
      }
      if (ns === 'class' && name === 'list') {
        return '${' + `classList(${requireValue('class:list')})` + '}'
      }
      if (ns === 'style' && name === 'list') {
        return '${' + `styleList(${requireValue('style:list')})` + '}'
      }
      throw new CompileError(
        `stator: directive "${ns}:${name}" is not supported yet (Phase 3b)`,
        loc(attr),
      )
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

  // A capitalized JSX tag (`<ProductList .../>`) is a Stator component
  // invocation — lower it to a call `Name({ ...props, children })`. Attributes
  // become props; children render eagerly into a `children` fragment (named
  // children via `child="x"` are stage 2).
  const lowerComponent = (
    tag: string,
    attrs: ts.JsxAttributes,
    children: ts.NodeArray<ts.JsxChild> | undefined,
  ): string => {
    const entries: string[] = []
    for (const attr of attrs.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        throw new CompileError(
          `stator: spread props ({...x}) on <${tag}/> are not supported`,
          loc(attr),
        )
      }
      if (ts.isJsxNamespacedName(attr.name)) {
        throw new CompileError(
          `stator: directive "${attr.name.namespace.text}:${attr.name.name.text}" is not valid on ` +
            `component <${tag}/> — directives apply to HTML elements, not components`,
          loc(attr),
        )
      }
      const name = attr.name.getText(sf)
      if (!attr.initializer) {
        entries.push(`${name}: true`) // boolean shorthand
      } else if (ts.isStringLiteral(attr.initializer)) {
        entries.push(`${name}: ${JSON.stringify(attr.initializer.text)}`)
      } else {
        entries.push(`${name}: ${attrExpr(attr)}`)
      }
    }

    if (children) {
      const inner = contentOfChildren(children)
      if (inner.trim() !== '') entries.push('children: html`' + inner + '`')
    }

    return `${tag}({ ${entries.join(', ')} })`
  }

  return 'html`' + doctype + contentOfChildren(fragment.children) + '`'
}

/** A capitalized tag name is a component invocation; lowercase / hyphenated is a
 *  literal HTML element (incl. custom elements). Matches React/Astro/Solid. */
function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag)
}

/** Escape literal template text so it round-trips inside a `\`…\`` literal. */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}
