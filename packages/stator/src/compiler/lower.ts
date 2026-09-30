import ts from 'typescript'
import { elementMarker, ISLAND_MARKER_ATTR, slotMarker } from '../wire/island-markers.ts'
import { type ClientDirective, inferDeps } from './client-script.ts'
import { CompileError, type DiagnosticLocation, locAt } from './diagnostics.ts'

export { CompileError } from './diagnostics.ts'

/**
 * Normalize JSX text whitespace the way JSX itself does (Babel's algorithm):
 * trim each line's leading/trailing spaces, drop blank lines, collapse a newline
 * between text into a single space — but PRESERVE inline single-line spaces, so
 * `{count} unsaved` keeps its space. Operates on a node's FULL text: `getText()`
 * skips a text node's leading trivia, which is what silently dropped the space
 * after an expression (`{x} unsaved` → `{x}unsaved`).
 */
function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i]!)) lastNonEmpty = i
  }
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, ' ')
    if (i !== 0) line = line.replace(/^ +/, '')
    if (i !== lines.length - 1) line = line.replace(/ +$/, '')
    if (!line) continue
    if (i !== lastNonEmpty) line += ' '
    out += line
  }
  return out
}

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

/** Placeholder bracketing a verbatim `<script is:inline>` while the surrounding
 *  template goes through the JSX parser. It's plain text (survives parsing and
 *  `escapeText` untouched) and is swapped back for the raw markup afterward. */
const INLINE_SCRIPT_RE = /<script\b([^>]*\bis:inline\b[^>]*)>([\s\S]*?)<\/script>/gi
const inlineMarker = (i: number): string => `\0statorInlineScript${i}\0`
// NUL (\0) delimits the marker precisely because it can never appear in an
// author's template, so it can't collide with real content.
const INLINE_MARKER_RE = /\0statorInlineScript(\d+)\0/g

export interface LowerMeta {
  /** This file's body contains a `<children>` placeholder (so the compiled
   *  function must accept a `props.children` bag). */
  usesChildren: boolean
  /** Named regions this file declares via `<children name="x"/>`. */
  regions: Set<string>
  /** Capitalized component tags invoked in this file (for cross-file
   *  resolution / validation in later stages). */
  components: Set<string>
  /** Custom-element tags (lowercase, hyphenated) used in this file's template —
   *  the client islands the `<script>` defines (Phase 3b). */
  customElements: Set<string>
  /** `ref:<name>` handles declared in the template (Phase 3b). */
  refs: Set<string>
}

export interface LowerOptions {
  /** Scope marker attribute, e.g. `data-s-a1b2c3d4`. Injected on every element. */
  scopeAttr?: string
  /** Original `.stator` source — enables located diagnostics. */
  source?: string
  /** Character offset in `source` where the template body begins. */
  templateOffset?: number
  /** File path, for diagnostics. */
  file?: string
  /** Out-param: the lowerer populates this with analysis metadata for
   *  compile()/validation/typegen. */
  meta?: LowerMeta
  /** Resolve a component identifier to the set of named regions it declares
   *  (`<children name="x"/>`). Returns null if unresolvable (e.g. not a
   *  `.stator` import, or no resolver wired) — in which case named-child
   *  validation is skipped for that component. Supplied by the Vite plugin /
   *  build, which can read sibling `.stator` files. */
  resolveRegions?: (componentName: string) => Set<string> | null
  /** Client-component mode. When set, `on:` directives and client-machine
   *  `read()`s are *collected* (with node/slot markers injected) instead of
   *  emitted as server directives — the generated client class wires them.
   *  `useFields` is the set of `use()` actor names (for dep inference);
   *  `directives` is the out-list. */
  client?: {
    useFields: Set<string>
    directives: ClientDirective[]
  }
}

/** If `jsx` is the body of an `each(arr, (item, index?) => …)` item renderer,
 *  return its item param name — so a `read(item, …)` inside lowers to a per-row
 *  itemBind. Null for a destructured item param (there's no name to match). */
function eachItemParamsFor(jsx: ts.Node): { item: string } | null {
  let node: ts.Node | undefined = jsx.parent
  while (node && ts.isParenthesizedExpression(node)) node = node.parent
  if (!node || !ts.isArrowFunction(node)) return null
  const call = node.parent
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null
  if (call.expression.text !== 'each' || call.arguments[1] !== node) return null
  const p0 = node.parameters[0]
  if (!p0 || !ts.isIdentifier(p0.name)) return null
  return { item: p0.name.text }
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

  // `<script is:inline>` is emitted verbatim: its body is raw JS (braces, `<`,
  // `${…}`) that must not pass through the JSX parser. Swap each for a text
  // placeholder now and splice the literal markup back into the output later.
  const inlineScripts: string[] = []
  template = template.replace(INLINE_SCRIPT_RE, (_m, attrs: string, body: string) => {
    const stripped = attrs.replace(/\s*is:inline(?:=("[^"]*"|'[^']*'|\{[^}]*\}))?/i, '')
    const i = inlineScripts.length
    inlineScripts.push(`<script${stripped}>${body}</script>`)
    return inlineMarker(i)
  })

  const wrapped = `const __t = (<>${template}</>);`
  const sf = ts.createSourceFile(
    'template.tsx',
    wrapped,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  )
  const scopeSuffix = opts.scopeAttr ? ` ${opts.scopeAttr}` : ''
  const meta = opts.meta

  // Item-value bindings (finding #5): the item param of the each row currently
  // being lowered (null outside any each, or for a destructured item param). A
  // `read(<item>, …)` inside such a row lowers to a per-row `itemBind`. Server
  // path only — itemBind needs server render state, so client-island shells keep
  // the plain lowering (and read(item, …) there stays a runtime error).
  let eachParams: { item: string } | null = null
  const enableItemBind = !opts.client

  /** `read(<itemParam>, selector)` — the explicit "this item field is live"
   *  marker, distinguished from a machine `read()` by its first argument being
   *  the current each item param. Lowered to `itemBind(selector)`. */
  const isItemRead = (n: ts.Node): n is ts.CallExpression =>
    enableItemBind &&
    eachParams !== null &&
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'read' &&
    n.arguments.length >= 2 &&
    n.arguments[0] !== undefined &&
    ts.isIdentifier(n.arguments[0]) &&
    n.arguments[0].text === eachParams.item

  /** `read(<useField>, selector)` in a client island — the display binding for
   *  a CLIENT-LOCAL machine (the `bind:`-as-display fold from the reactive-model
   *  spec). Routed to client codegen — a text slot or an attribute directive —
   *  never to the server shell, which has no such identifier. */
  const isClientRead = (n: ts.Node): n is ts.CallExpression =>
    opts.client !== undefined &&
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'read' &&
    n.arguments.length >= 2 &&
    n.arguments[0] !== undefined &&
    ts.isIdentifier(n.arguments[0]) &&
    opts.client.useFields.has(n.arguments[0].text)

  /** `bind:` was removed in 2.0 — display folds into `read()`, input capture
   *  is a typed commit event. One error, both compile modes. */
  const bindRemoved = (name: string, at: DiagnosticLocation | undefined): CompileError =>
    new CompileError(
      `stator: bind:${name} was removed in 2.0. Display state with read() — ` +
        `\`{read(m, (s) => s.value)}\` in text position, \`attr={read(m, …)}\` on an ` +
        `attribute — and capture input at a commit boundary with a typed event ` +
        `(ref:/FormData + send/dispatch). See the forms guide.`,
      at,
    )

  /** A client read as a plain expression: `(selector)(field)`. Client-emit's
   *  member rewriting turns `field` (and any use-field the selector closes
   *  over) into `this.field`. */
  const clientReadExpr = (call: ts.CallExpression): string =>
    `(${call.arguments[1]!.getText(sf)})(${(call.arguments[0] as ts.Identifier).text})`

  /** Slot markers live in their own `s<N>` namespace (element markers are
   *  `b<N>`); the shell renders `<!--s0-->` and the client materializes one
   *  text node per occurrence at setup. */
  const allocSlotMarker = (): string => {
    const client = opts.client
    if (!client) throw new CompileError('stator: internal — slot marker outside client mode')
    return slotMarker(client.directives.filter((d) => d.kind === 'slot').length)
  }

  /** Shell expressions must not contain a client-machine read — the shell
   *  evaluates server-side where the `use()` field doesn't exist. Whole-
   *  expression reads are routed to client codegen before this check. */
  const assertNoClientRead = (n: ts.Node): void => {
    if (!opts.client) return
    // Nested JSX is lowered by contentOfChild, which routes its own client
    // reads — don't descend into it from here.
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return
    if (isClientRead(n)) {
      throw new CompileError(
        `stator: read(${(n.arguments[0] as ts.Identifier).text}, …) on a client machine must be ` +
          `the entire expression — text position (\`{read(m, s => …)}\`) or attribute position ` +
          `(\`attr={read(m, s => …)}\`). Compose derived values inside the selector.`,
        loc(n),
      )
    }
    ts.forEachChild(n, assertNoClientRead)
  }

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

  // Build-time gate for the defer/machine boundary: a machine read — `read()`,
  // or a machine-bound each/when/match, which always wraps a `read()` — cannot
  // appear inside a `defer(...)`. A defer slot is static/one-shot and never
  // re-diffed, so a live binding there could never update. (The runtime
  // `registerBinding` guard is the backstop for reads reached through a helper
  // the static walk can't see.) This descends into nested JSX, which
  // `lowerExprText`'s walker deliberately does not.
  const checkNoReadInDefer = (node: ts.Node, insideDefer: boolean): void => {
    let nowInsideDefer = insideDefer
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === 'defer') {
        nowInsideDefer = true
      } else if (callee === 'read' && insideDefer) {
        throw new CompileError(
          `stator: read() cannot appear inside a defer() arm — a defer slot is one-shot and ` +
            `static, so the value would never update. For a live value, use a machine and place ` +
            `the read in a sibling slot outside the defer.`,
          loc(node),
        )
      }
    }
    ts.forEachChild(node, (child) => checkNoReadInDefer(child, nowInsideDefer))
  }
  checkNoReadInDefer(fragment, false)

  // Build-time gate for RCDATA elements: inside <textarea> and <title> the
  // parser treats children as RAW TEXT — a live-slot <span> (text-position
  // read()) or a region comment marker (each/when/match/defer) is rendered as
  // literal markup instead of becoming an element. Found in the wild: a
  // textarea pre-filled via read() displayed `<span data-slot="…"></span>` to
  // the user. Attributes on the element itself stay legal (attribute patches
  // need no wrapper) — the gate covers children only.
  const RCDATA_BINDINGS = new Set(['read', 'each', 'when', 'match', 'defer'])
  const checkNoBindingInRcdata = (node: ts.Node, rcdataTag: string | null): void => {
    if (
      rcdataTag &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      RCDATA_BINDINGS.has(node.expression.text)
    ) {
      const callee = node.expression.text
      throw new CompileError(
        `stator: ${callee}() cannot appear inside <${rcdataTag}> — its content is raw text ` +
          `(RCDATA), so the ${callee === 'read' ? 'live-slot wrapper' : 'region markers'} would ` +
          `render as literal markup. Interpolate a static value instead (a selector property ` +
          `like {machine.someSelector}, or a frontmatter constant); if the value must be live, ` +
          `bind an attribute or use an island.`,
        loc(node),
      )
    }
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement
      const tagName = ts.isIdentifier(opening.tagName) ? opening.tagName.text : null
      const isRcdata = tagName === 'textarea' || tagName === 'title'
      // Attributes keep the OUTER context; children enter the RCDATA scope.
      checkNoBindingInRcdata(opening, rcdataTag)
      for (const child of node.children) {
        checkNoBindingInRcdata(child, isRcdata ? tagName : rcdataTag)
      }
      checkNoBindingInRcdata(node.closingElement, rcdataTag)
      return
    }
    ts.forEachChild(node, (child) => checkNoBindingInRcdata(child, rcdataTag))
  }
  checkNoBindingInRcdata(fragment, null)

  // Build-time gate for item-read placement: a `read(<item>, …)` binding is
  // OWNED by its each() row — the row render supplies the item and collects the
  // binding, and the list's recompute is what re-diffs it. Three positions break
  // that ownership and are rejected here, rather than crashing (branch
  // re-renders run without row context) or silently going stale at runtime:
  //   1. inside a when()/match()/defer() — an arm re-renders on its own
  //      schedule, without the row;
  //   2. reading an OUTER each's item from inside a nested each() row — the
  //      inner row would evaluate the selector against the wrong item;
  //   3. inside a class:list / style:list spec — the compound directive
  //      recomposes per machine, not per row (deferred surface).
  // A nested each() INSIDE an arm is fine: it re-establishes row context for
  // its own items on every arm render. The runtime itemBind guard is the
  // backstop for hand-written templates that bypass the compiler.
  type PlacementFrame =
    | { kind: 'each'; param: string }
    | { kind: 'branch'; callee: string; position: 'head' | 'arm' }
    | { kind: 'list-attr'; attr: string }
  const checkItemReadPlacement = (node: ts.Node, frames: PlacementFrame[]): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      const arg0 = node.arguments[0]
      if (callee === 'read' && node.arguments.length >= 2 && arg0 && ts.isIdentifier(arg0)) {
        const param = arg0.text
        for (let i = frames.length - 1; i >= 0; i--) {
          const f = frames[i]!
          if (f.kind !== 'each' || f.param !== param) continue
          // `frames` above i sit between this read and the row that owns it.
          const between = frames.slice(i + 1)
          const branch = between.find((b) => b.kind === 'branch')
          if (branch && branch.kind === 'branch') {
            throw new CompileError(
              branch.position === 'head'
                ? `stator: read(${param}, …) cannot drive a ${branch.callee}() — a branch ` +
                    `binding needs a machine source to re-diff against. Derive the condition ` +
                    `in a machine selector and read that instead.`
                : `stator: read(${param}, …) cannot appear inside a ${branch.callee}() arm — ` +
                    `an item read is owned by its each() row, and an arm re-renders on its ` +
                    `own schedule without the row. Inside the arm, read the field from the ` +
                    `machine (read(machine, (m) => m.items.find(…))), or restructure so the ` +
                    `arm doesn't split the row (render both states and toggle with a class ` +
                    `binding + CSS).`,
              loc(node),
            )
          }
          const outer = between.find((b) => b.kind === 'each')
          if (outer) {
            throw new CompileError(
              `stator: read(${param}, …) reads an outer each()'s item from inside a nested ` +
                `each() row — an item read is owned by the row that binds its item, and the ` +
                `inner row would evaluate it against the wrong item. Derive the field onto ` +
                `the inner item, or use a machine read.`,
              loc(node),
            )
          }
          const listAttr = between.find((b) => b.kind === 'list-attr')
          if (listAttr && listAttr.kind === 'list-attr') {
            throw new CompileError(
              `stator: read(${param}, …) is not supported inside a ${listAttr.attr} spec — ` +
                `the compound directive recomposes per machine, not per row. Give the whole ` +
                `attribute a single item read (style={read(${param}, …)}), or use a machine ` +
                `read inside the spec.`,
              loc(node),
            )
          }
          break
        }
      }
      if (callee === 'when' || callee === 'match' || callee === 'defer') {
        node.arguments.forEach((arg, idx) => {
          checkItemReadPlacement(arg, [
            ...frames,
            { kind: 'branch', callee, position: idx === 0 ? 'head' : 'arm' },
          ])
        })
        return
      }
      if (callee === 'each') {
        const renderer = node.arguments[1]
        for (const arg of node.arguments) {
          if (arg === renderer && ts.isArrowFunction(arg)) {
            const p0 = arg.parameters[0]
            const inner: PlacementFrame[] =
              p0 && ts.isIdentifier(p0.name)
                ? [...frames, { kind: 'each', param: p0.name.text }]
                : frames
            checkItemReadPlacement(arg.body, inner)
          } else {
            checkItemReadPlacement(arg, frames)
          }
        }
        return
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      ts.isJsxNamespacedName(node.name) &&
      node.name.name.text === 'list' &&
      (node.name.namespace.text === 'class' || node.name.namespace.text === 'style')
    ) {
      const attr = `${node.name.namespace.text}:list`
      ts.forEachChild(node, (c) =>
        checkItemReadPlacement(c, [...frames, { kind: 'list-attr', attr }]),
      )
      return
    }
    ts.forEachChild(node, (c) => checkItemReadPlacement(c, frames))
  }
  if (enableItemBind) checkItemReadPlacement(fragment, [])

  const contentOfChildren = (children: ts.NodeArray<ts.JsxChild>): string => {
    let out = ''
    for (const child of children) out += contentOfChild(child)
    return out
  }

  const contentOfChild = (node: ts.JsxChild): string => {
    if (ts.isJsxText(node)) return escapeText(cleanJsxText(node.getFullText(sf)))
    if (ts.isJsxExpression(node)) {
      if (!node.expression) return '' // `{}` or `{/* comment */}`
      // Client-machine read in text position → a comment-marker slot; the
      // client materializes a text node there at setup and binds it. The
      // shell renders only the marker (islands paint client state at setup —
      // same initial-paint behavior bind:text has today).
      if (opts.client && isClientRead(node.expression)) {
        const marker = allocSlotMarker()
        const expr = clientReadExpr(node.expression)
        opts.client.directives.push({
          marker,
          kind: 'slot',
          expr,
          deps: inferDeps(expr, opts.client.useFields),
        })
        return `<!--${marker}-->`
      }
      // A plain `{item.field}` renders once (per the reactivity doctrine); a
      // `read(item, …)` is the live marker and is rewritten inside lowerExprText.
      return `\${${lowerExprText(node.expression)}}`
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(sf)
      if (tag === 'children') return lowerChildrenPlaceholder(node.openingElement.attributes)
      if (isComponentTag(tag)) {
        if (meta) meta.components.add(tag)
        return `\${${lowerComponent(tag, node.openingElement.attributes, node.children)}}`
      }
      if (meta && tag.includes('-')) meta.customElements.add(tag)
      const attrs = lowerAttributes(node.openingElement.attributes)
      return `<${tag}${attrs}${scopeSuffix}>${contentOfChildren(node.children)}</${tag}>`
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf)
      if (tag === 'children') return lowerChildrenPlaceholder(node.attributes)
      if (isComponentTag(tag)) {
        if (meta) meta.components.add(tag)
        return `\${${lowerComponent(tag, node.attributes, undefined)}}`
      }
      if (meta && tag.includes('-')) meta.customElements.add(tag)
      return `<${tag}${lowerAttributes(node.attributes)}${scopeSuffix} />`
    }
    if (ts.isJsxFragment(node)) return contentOfChildren(node.children)
    throw new CompileError(
      `stator: unsupported template node: ${ts.SyntaxKind[(node as ts.Node).kind]}`,
      loc(node as ts.Node),
    )
  }

  const lowerExprText = (expr: ts.Expression): string => {
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) {
      return `html\`${contentOfChild(expr as unknown as ts.JsxChild)}\``
    }
    assertNoClientRead(expr)
    // `read(item, selector)` → `itemBind(selector)` — a per-row live binding.
    if (isItemRead(expr)) {
      return `itemBind(${lowerExprText(expr.arguments[1]!)})`
    }

    const exprStart = expr.getStart(sf)
    let text = expr.getText(sf)
    const repls: Array<[start: number, end: number, replacement: string]> = []
    const visit = (n: ts.Node): void => {
      if (
        n !== expr &&
        (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
      ) {
        // If this JSX is an each row body, a `read(item, …)` inside it resolves to
        // the row's item param (save/restore handles nested each).
        const prevEach = eachParams
        const params = enableItemBind ? eachItemParamsFor(n) : null
        if (params) eachParams = params
        const lowered = `html\`${contentOfChild(n as unknown as ts.JsxChild)}\``
        eachParams = prevEach
        repls.push([n.getStart(sf), n.getEnd(), lowered])
        return // contentOfChild handles this node's internals
      }
      // Nested `read(item, …)` inside a larger expression (a ternary, a call arg).
      if (n !== expr && isItemRead(n)) {
        repls.push([n.getStart(sf), n.getEnd(), `itemBind(${n.arguments[1]!.getText(sf)})`])
        return
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
    // FINDINGS #1: a static `class` alongside `class:list` (or `style` +
    // `style:list`) emits two `class` attributes and the browser silently drops
    // one. Force everything through the `:list`, which takes a static string
    // alongside the dynamic parts.
    for (const ns of ['class', 'style'] as const) {
      const hasStatic = attrs.properties.some(
        (a) => ts.isJsxAttribute(a) && !ts.isJsxNamespacedName(a.name) && a.name.getText(sf) === ns,
      )
      const listAttr = attrs.properties.find(
        (a): a is ts.JsxAttribute =>
          ts.isJsxAttribute(a) &&
          ts.isJsxNamespacedName(a.name) &&
          a.name.namespace.text === ns &&
          a.name.name.text === 'list',
      )
      if (hasStatic && listAttr) {
        const example =
          ns === 'class'
            ? "class:list={['place-tab', { active }]}"
            : "style:list={['color: red', { ... }]}"
        throw new CompileError(
          `stator: an element has both a static \`${ns}\` attribute and \`${ns}:list\` — they ` +
            `emit two \`${ns}\` attributes and the browser silently keeps only one. Move the ` +
            `static ${ns} into \`${ns}:list\`, which accepts a static string alongside the ` +
            `dynamic parts: ${example}.`,
          loc(listAttr),
        )
      }
    }

    // Client mode: collect this element's on:/bind: directives AND client-read
    // attribute bindings under one node marker, strip them from the server
    // shell, emit `data-b="<marker>"` once.
    const collected = opts.client ? collectClientDirectives(attrs) : undefined

    let out = ''
    for (const attr of attrs.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        // `<el {...x}>` → a spreadAttrs directive in attribute-name position; at
        // render time it loops addAttribute over the bag (machine reads become
        // live attr bindings, item reads throw). See directives/spread.ts.
        out += ` \${spreadAttrs(${lowerExprText(attr.expression)})}`
        continue
      }
      // `child="x"` is a composition marker consumed by the parent component,
      // not a rendered HTML attribute — strip it from element output.
      if (
        ts.isJsxAttribute(attr) &&
        !ts.isJsxNamespacedName(attr.name) &&
        attr.name.getText(sf) === 'child'
      ) {
        continue
      }
      // In client mode, collected directives/bindings don't render in the shell.
      if (collected?.consumed.has(attr as ts.JsxAttribute)) continue
      const lowered = lowerAttribute(attr)
      if (lowered) out += ` ${lowered}`
    }
    if (collected?.marker) out += ` ${ISLAND_MARKER_ATTR}="${collected.marker}"`
    return out
  }

  // Collect a client element's wiring — on: directives plus plain attributes
  // whose value is a client-machine read — into `opts.client.directives`
  // under a single node marker. Returns the marker (if any wiring was found)
  // and the set of consumed attribute nodes the shell must not render.
  const collectClientDirectives = (
    attrs: ts.JsxAttributes,
  ): { marker?: string; consumed: Set<ts.JsxAttribute> } => {
    const consumed = new Set<ts.JsxAttribute>()
    const client = opts.client
    if (!client) return { consumed }
    const pending: ClientDirective[] = []
    for (const attr of attrs.properties) {
      if (!ts.isJsxAttribute(attr)) continue
      if (ts.isJsxNamespacedName(attr.name)) {
        const ns = attr.name.namespace.text
        const name = attr.name.name.text
        if (ns === 'bind') throw bindRemoved(name, loc(attr))
        if (ns !== 'on') continue
        const expr = attrExpr(attr)
        if (!expr) {
          throw new CompileError(`stator: on:${name} requires a handler ({...})`, loc(attr))
        }
        pending.push({ marker: '', kind: 'on', event: name, expr, deps: [] })
        consumed.add(attr)
        continue
      }
      // `attr={read(clientMachine, sel)}` — attribute-position client display
      // binding (the read()-fold of bind:<attr>).
      const init = attr.initializer
      if (init && ts.isJsxExpression(init) && init.expression && isClientRead(init.expression)) {
        const target = attr.name.getText(sf)
        if (target === 'value' || target === 'checked') {
          throw new CompileError(
            `stator: read() can't live-drive ${target}= from a client machine — the control owns ` +
              `its draft. Pre-fill with a server-rendered ${target} attribute, populate/reset via ` +
              `ref: at safe moments, and capture input with a typed commit event. See the forms ` +
              `guide.`,
            loc(attr),
          )
        }
        const expr = clientReadExpr(init.expression)
        pending.push({
          marker: '',
          kind: 'bind',
          target,
          expr,
          deps: inferDeps(expr, client.useFields),
        })
        consumed.add(attr)
      }
    }
    if (pending.length === 0) return { consumed }
    // One marker per element (sequential over ELEMENT markers — slots have
    // their own `s<N>` namespace).
    const marker = elementMarker(
      new Set(client.directives.filter((d) => d.kind !== 'slot').map((d) => d.marker)).size,
    )
    for (const d of pending) {
      d.marker = marker
      client.directives.push(d)
    }
    return { marker, consumed }
  }

  // `<children/>` → the default child bag entry; `<children name="x"/>` → the
  // named one. Empty string when absent, so a missing region renders nothing.
  const lowerChildrenPlaceholder = (attrs: ts.JsxAttributes): string => {
    if (meta) meta.usesChildren = true
    let region = 'default'
    for (const attr of attrs.properties) {
      if (
        ts.isJsxAttribute(attr) &&
        !ts.isJsxNamespacedName(attr.name) &&
        attr.name.getText(sf) === 'name' &&
        attr.initializer &&
        ts.isStringLiteral(attr.initializer)
      ) {
        region = attr.initializer.text
        if (meta) meta.regions.add(region)
      }
    }
    return `\${props.children?.${region} ?? ''}`
  }

  // Read a `child="x"` marker off a caller's child node (null = default bucket).
  const childRegionOf = (node: ts.JsxChild): string | null => {
    const attrs = ts.isJsxElement(node)
      ? node.openingElement.attributes
      : ts.isJsxSelfClosingElement(node)
        ? node.attributes
        : undefined
    if (!attrs) return null
    for (const attr of attrs.properties) {
      if (
        ts.isJsxAttribute(attr) &&
        !ts.isJsxNamespacedName(attr.name) &&
        attr.name.getText(sf) === 'child' &&
        attr.initializer &&
        ts.isStringLiteral(attr.initializer)
      ) {
        return attr.initializer.text
      }
    }
    return null
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
        return `\${on(${JSON.stringify(name)}, ${value})}`
      }
      if (ns === 'class' && name === 'list') {
        return `\${classList(${requireValue('class:list')})}`
      }
      if (ns === 'style' && name === 'list') {
        return `\${styleList(${requireValue('style:list')})}`
      }
      // `ref:name` — a client-addressable handle. Server renders a `data-ref`
      // marker; the client island exposes it as `this.refs.<name>`. The
      // directive carries no value (`<button ref:btn>`).
      if (ns === 'ref') {
        if (value) {
          throw new CompileError(
            `stator: ref:${name} takes no value (write \`ref:${name}\`)`,
            loc(attr),
          )
        }
        if (meta) meta.refs.add(name)
        return `data-ref=${JSON.stringify(name)}`
      }
      if (ns === 'bind') throw bindRemoved(name, loc(attr))
      throw new CompileError(`stator: directive "${ns}:${name}" is not supported`, loc(attr))
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
    // Directives on a component tag (`<Button on:click={h}>`) are collected into a
    // reserved `$directives` bag; the component re-attaches them to a chosen inner
    // element via `Stator.forwarded('on:click')`. First cut forwards `on:*` only.
    const forwarded: string[] = []
    for (const attr of attrs.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        // `<Comp {...x}>` → `...x` in the props object, in source order — a later
        // explicit prop overrides the spread, exactly as JSX evaluates.
        entries.push(`...${lowerExprText(attr.expression)}`)
        continue
      }
      if (ts.isJsxNamespacedName(attr.name)) {
        const ns = attr.name.namespace.text
        const dirName = attr.name.name.text
        if (ns === 'bind') throw bindRemoved(dirName, loc(attr))
        if (ns !== 'on') {
          throw new CompileError(
            `stator: forwarding "${ns}:${dirName}" to a component isn't supported yet — only ` +
              `on:* event directives forward. Apply ref: on an element directly.`,
            loc(attr),
          )
        }
        const value = attrExpr(attr)
        if (!value) {
          throw new CompileError(
            `stator: on:${dirName} on <${tag}/> requires a handler ({...})`,
            loc(attr),
          )
        }
        forwarded.push(`${JSON.stringify(`on:${dirName}`)}: ${value}`)
        continue
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
      const declared = opts.resolveRegions?.(tag) ?? null
      const defaultParts: string[] = []
      const named: Record<string, string> = {}
      for (const child of children) {
        const region = childRegionOf(child)
        const rendered = contentOfChild(child)
        if (region) {
          if (declared && !declared.has(region)) {
            const list = [...declared]
            throw new CompileError(
              `stator: <${tag}/> has no child region "${region}". ` +
                (list.length
                  ? `Declared regions: ${list.map((r) => `"${r}"`).join(', ')}. `
                  : `It declares no named regions. `) +
                `Add <children name="${region}"/> to ${tag}, or remove the child="${region}" marker.`,
              loc(child as ts.Node),
            )
          }
          named[region] = (named[region] ?? '') + rendered
        } else defaultParts.push(rendered)
      }
      const bag: string[] = []
      const defaultContent = defaultParts.join('')
      if (defaultContent.trim() !== '') bag.push(`default: html\`${defaultContent}\``)
      for (const [name, content] of Object.entries(named)) {
        bag.push(`${JSON.stringify(name)}: html\`${content}\``)
      }
      if (bag.length > 0) entries.push(`children: { ${bag.join(', ')} }`)
    }

    if (forwarded.length > 0) entries.push(`$directives: { ${forwarded.join(', ')} }`)
    return `${tag}({ ${entries.join(', ')} })`
  }

  const body = `html\`${doctype}${contentOfChildren(fragment.children)}\``
  // Splice verbatim `is:inline` scripts back in, escaped for the `html\`…\``
  // literal (the body may carry backticks / `$`).
  return inlineScripts.length === 0
    ? body
    : body.replace(INLINE_MARKER_RE, (_m, n: string) => escapeText(inlineScripts[Number(n)] ?? ''))
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
