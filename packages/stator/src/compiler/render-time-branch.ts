import ts from 'typescript'
import { parseDiagnosticsOf } from './diagnostics.ts'
import { INLINE_SCRIPT_RE } from './lower.ts'
import type { ScannedRegions } from './split.ts'

/**
 * Finds plain conditionals (`a ? b : c`, `a && b`) in a route or component
 * template whose test is decided once per render from a value that can change
 * afterwards, and whose arms allocate slot or element ids.
 *
 * Ids are positional per scope, and only `each` rows, `when`/`match` arms and
 * `defer` push a scope. A plain conditional doesn't, so the ids in and after
 * it depend on which way it went at render.
 *
 * A test is followed back through the frontmatter's top-level declarations to
 * one of two origins:
 *   - `Stator.request.claims()`;
 *   - a property or method read of a machine handle: a name destructured from
 *     `Stator.reads([...])`, or one destructured from `Stator.props()` that
 *     the template passes to `read()`.
 * Member access, method calls on the value, operators, casts and
 * destructuring are followed; a call to a free function is not.
 */

export interface RenderTimeBranch {
  /** Offset of the conditional in the original `.stator` source. */
  offset: number
  message: string
}

interface Origin {
  kind: 'claims' | 'machine'
  /** The machine handle read, for `kind: 'machine'`. */
  handle?: string
  /** A `read()` selector that computes the same value, when one can be written. */
  selector?: string
  /** Reached without passing through a frontmatter binding. */
  direct: boolean
}

interface Bindings {
  handles: Set<string>
  origins: Map<string, Origin>
}

/** An id scope: the offsets of the bindings allocated in it, and whether it
 *  is an arm of a `when`/`match` driven by a `read()`. */
interface Scope {
  binds: number[]
  live: boolean
}

interface Candidate {
  node: ts.Expression
  test: ts.Expression
  arms: ts.Expression[]
  scope: Scope
  origin: Origin
  shadowed: ReadonlySet<string>
}

const WRAP_PREFIX = 'const __t = (<>'
const BINDING_CALLS = new Set(['read', 'each', 'when', 'match', 'defer'])
const SCOPE_CALLS = new Set(['each', 'when', 'match', 'defer'])
const MAX_QUOTED = 60

export function renderTimeBranches(regions: ScannedRegions): RenderTimeBranch[] {
  // An island's template is wired by its client class; its reads are client reads.
  if (!regions.frontmatter || regions.scripts.length > 0) return []

  // Blanked rather than removed, so parsed positions stay source positions.
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ')
  const template = regions.template.content
    .replace(/^\s*<!doctype[^>]*>/i, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(INLINE_SCRIPT_RE, blank)
  const sf = ts.createSourceFile(
    'template.tsx',
    `${WRAP_PREFIX}${template}</>);`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  if (parseDiagnosticsOf(sf).length > 0) return []

  const readTargets = new Set<string>()
  const collectReadTargets = (node: ts.Node): void => {
    if (isCallTo(node, 'read')) {
      const target = node.arguments[0]
      if (target && ts.isIdentifier(target)) readTargets.add(target.text)
    }
    ts.forEachChild(node, collectReadTargets)
  }
  collectReadTargets(sf)

  const bindings = frontmatterBindings(regions.frontmatter.content, readTargets)
  if (bindings.handles.size === 0 && bindings.origins.size === 0) return []

  const allBinds: number[] = []
  const candidates: Candidate[] = []
  const visit = (node: ts.Node, scope: Scope, shadowed: ReadonlySet<string>): void => {
    const bind = (): void => {
      scope.binds.push(node.getStart(sf))
      allBinds.push(node.getStart(sf))
    }
    if (ts.isFunctionLike(node)) {
      visitEach(node, scope, new Set([...shadowed, ...localNames(node)]))
      return
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      BINDING_CALLS.has(node.expression.text)
    ) {
      bind()
      const callee = node.expression.text
      if (SCOPE_CALLS.has(callee)) {
        const head = node.arguments[0]
        const live = (callee === 'when' || callee === 'match') && !!head && isCallTo(head, 'read')
        node.arguments.forEach((arg, i) => {
          if (i === 0) visit(arg, scope, shadowed)
          else if (ts.isObjectLiteralExpression(arg)) {
            for (const arm of arg.properties) visit(arm, { binds: [], live }, shadowed)
          } else visit(arg, { binds: [], live }, shadowed)
        })
        return
      }
    } else if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      /^[A-Z]/.test(node.tagName.getText(sf))
    ) {
      // A component renders in its caller's scope and may bind anything.
      bind()
    } else if (
      ts.isJsxAttribute(node) &&
      ts.isJsxNamespacedName(node.name) &&
      node.name.namespace.text === 'on'
    ) {
      bind()
    } else if (ts.isConditionalExpression(node) || isLogicalAnd(node)) {
      const [test, arms] = ts.isConditionalExpression(node)
        ? [node.condition, [node.whenTrue, node.whenFalse]]
        : [node.left, [node.right]]
      const origin = originOf(test, sf, bindings, shadowed)
      if (origin) candidates.push({ node, test, arms, scope, origin, shadowed })
    }
    visitEach(node, scope, shadowed)
  }
  const visitEach = (node: ts.Node, scope: Scope, shadowed: ReadonlySet<string>): void => {
    ts.forEachChild(node, (child) => visit(child, scope, shadowed))
  }
  visit(sf, { binds: [], live: false }, new Set())

  const out: RenderTimeBranch[] = []
  let reportedEnd = -1
  for (const c of candidates) {
    const start = c.node.getStart(sf)
    // One finding per chain: a conditional inside a reported one is the same choice.
    if (start < reportedEnd) continue
    const armBinds = c.arms.some((arm) =>
      allBinds.some((at) => at >= arm.getStart(sf) && at < arm.end),
    )
    if (!armBinds) continue
    // A read-driven arm is re-rendered whole when its branch flips, so a
    // conditional in one only matters when it shifts a later binding there.
    if (c.scope.live && !c.scope.binds.some((at) => at >= c.node.end)) continue
    reportedEnd = c.node.end
    out.push({
      offset: regions.template.contentOffset + start - WRAP_PREFIX.length,
      message: messageFor(c, sf, bindings),
    })
  }
  return out
}

function messageFor(c: Candidate, sf: ts.SourceFile, bindings: Bindings): string {
  const subject = subjectOf(c.test, bindings, c.shadowed) ?? c.origin.handle ?? 'it'
  const lead =
    `this branch is chosen once, when the page renders. If \`${subject}\` changes later, live ` +
    `updates in or after it can land on the wrong elements until the page reloads. `
  if (c.origin.kind === 'claims') {
    const test = c.test.getText(sf)
    const quoted = test.length <= MAX_QUOTED && !test.includes('\n') ? test : '…'
    return (
      `${lead}Use when(${quoted}, …) to keep the ids around it stable; if the branch must ` +
      `follow sign-in and sign-out, keep the identity in a session machine and use ` +
      `when(read(machine, …), …).`
    )
  }
  const handle = c.origin.handle!
  const bare = unwrap(c.test)
  const selector =
    (ts.isIdentifier(bare) ? c.origin.selector : undefined) ??
    (c.origin.direct ? selectorFor(c.test, handle, sf) : undefined) ??
    `(${paramFor(handle)}) => …`
  return `${lead}Use when(read(${handle}, ${selector}), …) so the branch is part of the page's live state.`
}

/** The first frontmatter binding with an origin that `test` references. */
function subjectOf(
  test: ts.Expression,
  bindings: Bindings,
  shadowed: ReadonlySet<string>,
): string | undefined {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && bindings.origins.has(node.text) && !shadowed.has(node.text)) {
      found = node.text
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(test)
  return found
}

/** Handles and origin-carrying names declared at the top level of a fence. */
function frontmatterBindings(frontmatter: string, readTargets: ReadonlySet<string>): Bindings {
  const sf = ts.createSourceFile('fm.ts', frontmatter, ts.ScriptTarget.Latest, true)
  const bindings: Bindings = { handles: new Set(), origins: new Map() }
  const none = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue
      const init = unwrap(decl.initializer)
      const names = boundNames(decl.name)
      if (isStatorCall(init, 'reads')) {
        if (ts.isArrayBindingPattern(decl.name)) for (const n of names) bindings.handles.add(n)
        continue
      }
      if (isStatorCall(init, 'props')) {
        if (ts.isObjectBindingPattern(decl.name)) {
          for (const n of names) if (readTargets.has(n)) bindings.handles.add(n)
        }
        continue
      }
      const origin: Origin | undefined =
        ts.isIdentifier(init) && bindings.handles.has(init.text)
          ? { kind: 'machine', handle: init.text, direct: false }
          : originOf(init, sf, bindings, none)
      if (!origin) continue
      const selector =
        ts.isIdentifier(decl.name) && origin.direct && origin.handle
          ? selectorFor(init, origin.handle, sf)
          : undefined
      for (const n of names) bindings.origins.set(n, { ...origin, selector, direct: false })
    }
  }
  return bindings
}

/** Where the value of `node` comes from, if that is claims or a machine
 *  handle. A free function call ends the trail. */
function originOf(
  node: ts.Expression,
  sf: ts.SourceFile,
  bindings: Bindings,
  shadowed: ReadonlySet<string>,
): Origin | undefined {
  const follow = (n: ts.Expression): Origin | undefined => originOf(n, sf, bindings, shadowed)
  const e = unwrap(node)
  if (ts.isIdentifier(e)) return shadowed.has(e.text) ? undefined : bindings.origins.get(e.text)
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'claims') {
      const target = unwrap(callee.expression)
      if (ts.isPropertyAccessExpression(target) && isStatorMember(target, 'request')) {
        return { kind: 'claims', direct: true }
      }
    }
    return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
      ? follow(callee)
      : undefined
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const target = unwrap(e.expression)
    if (
      ts.isIdentifier(target) &&
      bindings.handles.has(target.text) &&
      !shadowed.has(target.text)
    ) {
      return { kind: 'machine', handle: target.text, direct: true }
    }
    return follow(target)
  }
  if (ts.isBinaryExpression(e)) return follow(e.left) ?? follow(e.right)
  if (ts.isPrefixUnaryExpression(e)) return follow(e.operand)
  if (ts.isTypeOfExpression(e)) return follow(e.expression)
  if (ts.isConditionalExpression(e)) {
    return follow(e.condition) ?? follow(e.whenTrue) ?? follow(e.whenFalse)
  }
  return undefined
}

/** `expr` as a `read()` selector over `handle`: the handle renamed to the
 *  selector's parameter. Undefined when it is too long to quote or the
 *  parameter name is already taken in it. */
function selectorFor(expr: ts.Expression, handle: string, sf: ts.SourceFile): string | undefined {
  const start = expr.getStart(sf)
  const text = expr.getText(sf)
  if (text.length > MAX_QUOTED || text.includes('\n')) return undefined
  const param = paramFor(handle)
  const uses: number[] = []
  let taken = false
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      if (node.text === handle) uses.push(node.getStart(sf) - start)
      else if (node.text === param) taken = true
    }
    ts.forEachChild(node, visit)
  }
  visit(expr)
  if (taken) return undefined
  let body = text
  for (const at of uses.reverse()) body = body.slice(0, at) + param + body.slice(at + handle.length)
  return `(${param}) => ${body}`
}

const paramFor = (handle: string): string => handle[0]!.toLowerCase()

function isPropertyName(id: ts.Identifier): boolean {
  const p = id.parent
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isPropertyAssignment(p) && p.name === id)
  )
}

/** Parameters and variables a function declares, which hide a frontmatter
 *  binding of the same name inside it. */
function localNames(fn: ts.SignatureDeclaration): string[] {
  const names: string[] = []
  for (const p of fn.parameters) names.push(...boundNames(p.name))
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) names.push(...boundNames(node.name))
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return names
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((el) => (ts.isBindingElement(el) ? boundNames(el.name) : []))
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
  )
}

function isLogicalAnd(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
}

function isStatorCall(node: ts.Expression, member: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    isStatorMember(node.expression, member)
  )
}

function isStatorMember(e: ts.PropertyAccessExpression, member: string): boolean {
  return ts.isIdentifier(e.expression) && e.expression.text === 'Stator' && e.name.text === member
}
