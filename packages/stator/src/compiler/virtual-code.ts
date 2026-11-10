/**
 * Language-server emit: turn a `.stator` file into **mapped virtual code** the
 * editor tooling can hand to real language services (TS for the script/template,
 * CSS for styles), with every generated position mapped back to the source so
 * completions, hover, and diagnostics land in the right place.
 *
 * This is a *second* emit target, distinct from the runtime `compile()`:
 *   - `compile()` rewrites the template to `html\`…\`` for execution.
 *   - `toVirtualCode()` preserves the template as JSX so TS's own JSX service
 *     gives intelligence, and preserves source offsets for mapping.
 *
 * It shares the front end (`scanRegions`) with the compiler so the two never
 * disagree about `.stator` syntax — the drift trap in embedded-language tooling.
 *
 * v1 scope: correct region mappings + a useful TSX shell. The ambient typing
 * (`Stator`, JSX intrinsics — see `ambientFor`) is intentionally permissive
 * on JSX and refined against real in-editor feedback; the mappings are the
 * load-bearing part.
 */

import ts from 'typescript'
import { VOID_ELEMENTS } from '../template/void-elements.ts'
import { attrsInterface } from './client-emit.ts'
import { analyzeScriptClasses, pascalToKebab } from './client-script.ts'
import { parseDiagnosticsOf } from './diagnostics.ts'
import { extractFrontmatterTypes, statorPropsType } from './dts.ts'
import { CLIENT_AUTHOR_GLOBALS, TEMPLATE_AUTHOR_GLOBALS } from './emit-names.ts'
import { type ScannedRegions, scanRegions } from './split.ts'

/** A contiguous run mapping generated code back to source, 1:1 over its length. */
export interface VirtualMapping {
  sourceOffset: number
  generatedOffset: number
  length: number
}

export interface VirtualFile {
  lang: 'tsx' | 'css'
  code: string
  mappings: VirtualMapping[]
}

export interface VirtualCodeResult {
  /** The TSX shell: frontmatter + template (server component) or the client
   *  `<script>` module (client component). */
  tsx: VirtualFile
  /** One CSS virtual file per `<style>` block. */
  styles: VirtualFile[]
}

// The editor injects the AUTHOR-visible subsets only — lowering targets are
// names authors never write, so injecting them here would shadow nothing and
// pollute completions. Shared with the emitters via emit-names.ts.
const TEMPLATE_GLOBALS = TEMPLATE_AUTHOR_GLOBALS
const CLIENT_GLOBALS = CLIENT_AUTHOR_GLOBALS

/** Local names the user's code already binds from `modulePath` imports —
 *  the runtime strips such habit-imports; the virtual emit (which must keep
 *  offsets faithful) instead injects only what the user DIDN'T import. */
function userImportedLocals(code: string, modulePath: string): Set<string> {
  const locals = new Set<string>()
  const re = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${modulePath.replace(/\//g, '\\/')}['"]`,
    'g',
  )
  for (const m of code.matchAll(re)) {
    for (const spec of m[1]!.split(',')) {
      const parts = spec.trim().split(/\s+as\s+/)
      const local = (parts[1] ?? parts[0] ?? '').trim().replace(/^type\s+/, '')
      if (local) locals.add(local)
    }
  }
  return locals
}

function injectImports(globals: readonly string[], modulePath: string, userCode: string): string {
  const bound = userImportedLocals(userCode, modulePath)
  const missing = globals.filter((g) => !bound.has(g))
  return missing.length > 0 ? `import { ${missing.join(', ')} } from '${modulePath}';\n` : ''
}
// Aliased so they never collide with a component's own `InstanceOf` import.
// NOTE: `InstanceOf` comes from /template, not /machine — the template flavor
// includes `send`/`state`/`snapshot` (what a route-level binding actually is,
// and what authors type props with). The engine flavor is selectors-only (the
// read-only view actions get via `helpers.reads`) and would make every
// `Stator.reads` binding unassignable to component props.
const BUNDLED_TYPE_IMPORTS =
  "import type { AnyMachineDef as __SMachineDef } from '@statorjs/stator/machine';\n" +
  "import type { InstanceOf as __SInstanceOf } from '@statorjs/stator/template';\n"
const INTRINSICS_IMPORT =
  "import type { StatorIntrinsicElements as __SIntrinsics } from '@statorjs/stator/template';\n"

/**
 * Per-file ambient scaffold prepended to every virtual TSX. `Stator` (the macro
 * surface, module-scoped) makes `Stator.props`/`reads`/… resolve — `reads` typed
 * through `InstanceOf` so a route's bindings infer their machine instance types.
 * The **global** JSX namespace is permissive (`extends Record<string, any>`), so
 * directives + custom elements don't flood false errors; it must be `declare
 * global` because TS resolves `JSX.IntrinsicElements` globally, and `extends
 * Record` (rather than an own index signature) lets every file's copy merge
 * without a duplicate-index-signature clash. Elements are not typed per tag
 * here.
 */
const JSX_GLOBAL = `declare global {
  namespace JSX {
    interface IntrinsicElements extends __SIntrinsics {}
  }
}
`

/**
 * Where the `Stator` macros' types come from (see `src/editor.ts`).
 *
 * - `project`: from the project's installed `@statorjs/stator/editor`, so the
 *   editor shows the API of the release the project actually runs. The
 *   language server picks this whenever the installed package exports it.
 * - `bundled`: the inline shape below, for installs that predate the editor
 *   contract. It is FROZEN as the surface of those releases. Never edit it for
 *   a new or renamed macro: a change here reaches only old projects, where it
 *   would be wrong. New API goes in `StatorMacros`.
 */
export type AmbientSource = 'project' | 'bundled'

const BUNDLED_STATOR = `declare const Stator: {
  props<P>(): P;
  reads<const T extends readonly __SMachineDef[]>(defs: T): { -readonly [K in keyof T]: __SInstanceOf<T[K]> };
  forwarded(name: \`on:\${string}\`): (() => unknown) | undefined;
  request: any;
  response: { status: number; headers: Headers; cookies: any };
};
`

const PROJECT_STATOR =
  "import type { StatorMacros as __SMacros } from '@statorjs/stator/editor';\n" +
  'declare const Stator: __SMacros;\n'

function ambientFor(source: AmbientSource): string {
  return source === 'project'
    ? INTRINSICS_IMPORT + PROJECT_STATOR + JSX_GLOBAL
    : BUNDLED_TYPE_IMPORTS + INTRINSICS_IMPORT + BUNDLED_STATOR + JSX_GLOBAL
}

export interface VirtualCodeOptions {
  /** Where the `Stator` macros are typed from. Defaults to `bundled`. */
  ambient?: AmbientSource
}

const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i

export function toVirtualCode(source: string, opts: VirtualCodeOptions = {}): VirtualCodeResult {
  const regions = scanRegions(source)
  const ambient = ambientFor(opts.ambient ?? 'bundled')
  const isClient =
    regions.scripts.length > 0 &&
    analyzeScriptClasses(regions.scripts.map((s) => s.content).join('\n')).length > 0

  return {
    tsx: isClient ? buildClientTsx(regions, ambient) : buildServerTsx(regions, ambient),
    styles: regions.styles.map(buildCssFile),
  }
}

/** Server component: import/type/interface declarations hoist to module scope;
 *  the executable frontmatter body + the template (a JSX fragment) live inside
 *  the render function, so template expressions see the frontmatter's bindings.
 *
 *  The body is deliberately NOT at module scope: it runs as a synchronous
 *  function body at runtime (compile.ts wraps it the same way), so modelling it
 *  as one here is what makes top-level `await` / `return` the TS errors they
 *  should be. Emitting the body at module scope (the previous shape) silently
 *  made them legal in-editor while diverging from runtime semantics. */
function buildServerTsx(regions: ScannedRegions, ambient: string): VirtualFile {
  const mappings: VirtualMapping[] = []
  const fm = regions.frontmatter?.content ?? ''
  const fmOffset = regions.frontmatter?.contentOffset ?? 0
  const userCode = fm + regions.template.content
  let code = injectImports(TEMPLATE_GLOBALS, '@statorjs/stator/template', userCode) + ambient

  const { hoisted, body } = splitFrontmatter(fm, fmOffset)
  for (const seg of hoisted) code = emitSegment(mappings, code, seg)

  // A leading <!doctype> is static HTML, not JSX — drop it from the shell (no
  // intelligence lost) and advance the template mapping past it.
  let tplOffset = regions.template.contentOffset
  let tpl = regions.template.content
  const doctype = DOCTYPE_RE.exec(tpl)
  if (doctype) {
    tplOffset += doctype[0].length
    tpl = tpl.slice(doctype[0].length)
  }

  // `export default function` gives importers a default export (`import X from
  // './x.stator'`) and a scope that closes over the frontmatter body. The param
  // is typed from `Stator.props<P>()` (same extraction as the .d.ts generator),
  // so `<Component bad={...}/>` in OTHER .stator files is checked in-editor.
  // Named prop types resolve because their type/interface decls hoisted above.
  const { propsT, needsReadResult } = statorPropsType(
    fm,
    regions.template.content,
    regions.scripts.map((s) => s.content),
  )
  if (needsReadResult) {
    code += "type __SReadResult<T> = import('@statorjs/stator/template').ReadResult<T>\n"
  }
  code += `export default function (_props: ${propsT}) {\n`
  for (const seg of body) code = emitSegment(mappings, `${code}  `, seg)
  code += '  return (<>'
  code = appendTemplateTsx(code, mappings, tpl, tplOffset)
  code += '</>);\n}\n'

  return { lang: 'tsx', code, mappings }
}

/**
 * Append the template to the virtual TSX with HTML→TSX compatibility applied
 * AND offset mappings kept exact around every edit:
 *   - HTML comments: dropped (not JSX),
 *   - `is:inline` scripts: body blanked to `<script />` (raw JS can't parse
 *     as JSX children, and typechecking it as TSX would be meaningless),
 *   - void elements: self-closed (`<input>` → `<input />`).
 * The walk is brace- and quote-aware so attribute expressions
 * (`checked={(t) => t.done}`, `title="a > b"`) are never rewritten. Verbatim
 * runs get 1:1 mappings; inserted text maps to nothing; dropped source simply
 * has no generated counterpart. Both the editor (Volar) and the emitted
 * `.stator/check` files share this one surface.
 */
function appendTemplateTsx(
  code: string,
  mappings: VirtualMapping[],
  tpl: string,
  tplOffset: number,
  untypedProps = false,
): string {
  let out = code
  let i = 0
  let runStart = 0

  const flush = (end: number): void => {
    if (end > runStart) {
      push(mappings, tplOffset + runStart, out.length, end - runStart)
      out += tpl.slice(runStart, end)
    }
  }

  // Type the callback parameters `props` leaves untyped, in the `{…}` at
  // [start, end). Each insertion sits between two verbatim runs.
  const annotate = (start: number, end: number): void => {
    if (!untypedProps) return
    for (const edit of untypedParamEdits(tpl.slice(start, end))) {
      flush(start + edit.at)
      out += edit.text
      runStart = start + edit.at
    }
  }

  while (i < tpl.length) {
    if (tpl.startsWith('<!--', i)) {
      flush(i)
      const end = tpl.indexOf('-->', i)
      i = end === -1 ? tpl.length : end + 3
      runStart = i
      continue
    }
    if (/^<script\b/i.test(tpl.slice(i, i + 8))) {
      flush(i)
      const end = tpl.toLowerCase().indexOf('</script>', i)
      out += '<script />'
      i = end === -1 ? tpl.length : end + '</script>'.length
      runStart = i
      continue
    }
    if (tpl[i] === '{') {
      const end = expressionEnd(tpl, i)
      annotate(i, end)
      i = end
      continue
    }
    if (tpl[i] === '<' && /[a-zA-Z]/.test(tpl[i + 1] ?? '')) {
      const tag = /^[a-zA-Z][\w-]*/.exec(tpl.slice(i + 1))![0]
      let j = i + 1 + tag.length
      while (j < tpl.length) {
        const ch = tpl[j]!
        if (ch === '"' || ch === "'") {
          const q = tpl.indexOf(ch, j + 1)
          j = q === -1 ? tpl.length : q + 1
          continue
        }
        if (ch === '{') {
          const end = expressionEnd(tpl, j)
          annotate(j, end)
          j = end
          continue
        }
        if (ch === '>') break
        j++
      }
      if (VOID_ELEMENTS.has(tag.toLowerCase()) && j < tpl.length) {
        // Self-close unless the author already did.
        let k = j - 1
        while (k > i && /\s/.test(tpl[k]!)) k--
        if (tpl[k] !== '/') {
          flush(j)
          out += ' /'
          runStart = j // continue the run at the original `>`
        }
      }
      i = j + 1
      continue
    }
    i++
  }
  flush(tpl.length)
  return out
}

/**
 * An island shell's `props` are open (`any`), so a callback handed to a call
 * on them, `props.rows.map((r) => …)`, has parameters nothing can type, which
 * `noImplicitAny` reports. This finds those parameters in a `{…}` expression
 * and returns the `: any` to insert after each, in source order. A parameter
 * typed this way is untyped in turn, so a nested `r.cells.map((c) => …)` is
 * covered. Callbacks over anything else are left for TypeScript to type.
 */
function untypedParamEdits(expr: string): Array<{ at: number; text: string }> {
  if (!expr.includes('props') || !expr.includes('=>')) return []
  // `{…}` parses as a block holding the expression; offsets stay the source's.
  const sf = ts.createSourceFile('e.tsx', expr, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const untyped = new Set(['props'])
  const edits: Array<{ at: number; text: string }> = []
  const mentionsUntyped = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && untyped.has(node.text)) ||
    ts.forEachChild(node, mentionsUntyped) === true
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && mentionsUntyped(node.expression)) {
      for (const arg of node.arguments) {
        if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue
        const bare = !arg.getChildren(sf).some((c) => c.kind === ts.SyntaxKind.OpenParenToken)
        for (const param of arg.parameters) {
          if (param.type || param.dotDotDotToken) continue
          const paren = ts.isArrowFunction(arg) && bare && arg.parameters.length === 1
          if (paren) edits.push({ at: param.getStart(sf), text: '(' })
          edits.push({ at: param.name.getEnd(), text: paren ? ': any)' : ': any' })
          const bind = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) untyped.add(name.text)
            else for (const el of name.elements) if (ts.isBindingElement(el)) bind(el.name)
          }
          bind(param.name)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return edits.sort((a, b) => a.at - b.at)
}

/** Index just past the `}` closing the expression opened at `start` (which
 *  must point at `{`), respecting nested braces and string/template literals. */
function expressionEnd(tpl: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < tpl.length; i++) {
    const ch = tpl[i]!
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return tpl.length
}

interface FmSegment {
  sourceOffset: number
  text: string
  /** The statement has a syntax error in TS mode (JSX in the fence, usually).
   *  Emitted as a string literal so the TSX model can't make it look fine —
   *  the compiler's located error is the one the editor shows. */
  opaque?: boolean
}

function emitSegment(mappings: VirtualMapping[], code: string, seg: FmSegment): string {
  if (seg.opaque) return `${code}${JSON.stringify(seg.text)};\n`
  push(mappings, seg.sourceOffset, code.length, seg.text.length)
  return `${code}${seg.text}\n`
}

/**
 * Split frontmatter into hoisted declarations (import/type/interface — must be
 * module scope) and body statements (everything else — the render function).
 * Mirrors the runtime classification in `compile.ts` `processFrontmatter`, so
 * the editor models the same scoping. Each segment keeps its exact source range
 * (`getStart`..`getText`) so the mapping stays a verbatim 1:1 run.
 */
function splitFrontmatter(
  fm: string,
  fmOffset: number,
): { hoisted: FmSegment[]; body: FmSegment[] } {
  const hoisted: FmSegment[] = []
  const body: FmSegment[] = []
  if (!fm.trim()) return { hoisted, body }
  const sf = ts.createSourceFile('fm.ts', fm, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // A syntax error splits what the author wrote as one statement into pieces
  // (`return <p>not` / `found</p>`), and the piece without the diagnostic would
  // read as valid JSX in the TSX model. Every statement sharing a line with a
  // diagnostic is opaque.
  const brokenLines = new Set(
    parseDiagnosticsOf(sf).map((d) => sf.getLineAndCharacterOfPosition(d.start).line),
  )
  for (const stmt of sf.statements) {
    const start = stmt.getStart(sf)
    const seg: FmSegment = { sourceOffset: fmOffset + start, text: stmt.getText(sf) }
    const first = sf.getLineAndCharacterOfPosition(start).line
    const last = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line
    for (let line = first; line <= last; line++) {
      if (brokenLines.has(line)) seg.opaque = true
    }
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)
    ) {
      hoisted.push(seg)
    } else {
      body.push(seg)
    }
  }
  return { hoisted, body }
}

/** Client component: the `<script>` is the module. Emit it as TS so the class,
 *  `use()`/`machine()`, and imports get full intelligence.
 *
 *  The template is the island's server shell, and sees three scopes: the
 *  fence's bindings, the shell's `props`, and the element class's members
 *  (a `use()` field in a client `read()`, a method in `on:`). It is emitted
 *  inside the fence function, as a method of a subclass of the element, the
 *  shape the compiled client module gives the same expressions. `props` is
 *  open there: an island declares only its attrs, and its shell may consume
 *  any prop its use site passes. */
function buildClientTsx(regions: ScannedRegions, ambient: string): VirtualFile {
  const mappings: VirtualMapping[] = []
  const userScript = regions.scripts.map((s) => s.content).join('\n')
  const tpl = regions.template.content
  const rootTag = /^\s*<([a-z][\w-]*)/.exec(tpl)?.[1]
  const classes = analyzeScriptClasses(userScript)
  const element = classes.find((c) => pascalToKebab(c.name) === rootTag)
  let code =
    injectImports(TEMPLATE_GLOBALS, '@statorjs/stator/template', userScript) +
    injectImports(CLIENT_GLOBALS, '@statorjs/stator/client', userScript) +
    ambient

  // The island's SERVER FENCE: typed here so the editor checks it, but
  // wrapped so its bindings don't leak into the <script>'s scope (at runtime
  // the two never meet). Hoisted imports that also appear verbatim in the
  // script are skipped — same module, one binding.
  const fm = regions.frontmatter?.content ?? ''
  if (fm.trim() || element) {
    const fmOffset = regions.frontmatter?.contentOffset ?? 0
    const { hoisted, body } = splitFrontmatter(fm, fmOffset)
    for (const seg of hoisted) {
      if (userScript.includes(seg.text.trim())) continue
      code = emitSegment(mappings, code, seg)
    }
    code += 'function __statorFence(props: Record<string, unknown>) {\n'
    for (const seg of body) code = emitSegment(mappings, `${code}  `, seg)
    if (element) {
      const members = [...element.members].filter((m) => m !== 'props')
      // Declared with `Stator.props<P>()`, the shell's props are P plus the
      // attrs; undeclared, they are open.
      const { propsType } = extractFrontmatterTypes(fm)
      const declared = propsType
        ? statorPropsType(fm, tpl, [userScript]).propsT.replaceAll(
            '__SReadResult<',
            "import('@statorjs/stator/template').ReadResult<",
          )
        : undefined
      code += `  class __StatorShell extends ${element.name} {\n`
      code += `    __shell(props: ${declared ?? 'Record<string, any>'}) {\n`
      if (members.length > 0) {
        code += `      const { ${members.join(', ')} } = this; void [${members.join(', ')}];\n`
      }
      code += '      void props;\n      return (<>'
      code = appendTemplateTsx(code, mappings, tpl, regions.template.contentOffset, !declared)
      code += '</>);\n    }\n  }\n  void __StatorShell\n'
    }
    code += '}\nvoid __statorFence\n'
  }

  for (const script of regions.scripts) {
    push(mappings, script.contentOffset, code.length, script.content.length)
    code += `${script.content}\n`
  }

  for (const cls of classes) {
    if (cls.staticAttrs.size > 0) code += `${attrsInterface(cls.name)}\n`
  }

  // A client component is also used as `<Tag/>` elsewhere, so its importers need
  // a default export too. The named class export above still gets full TS
  // intelligence; this stub just satisfies the import.
  code += '\nexport default function (_props: any) { return null as any; }\n'

  return { lang: 'tsx', code, mappings }
}

function buildCssFile(style: { contentOffset: number; content: string }): VirtualFile {
  return {
    lang: 'css',
    code: style.content,
    mappings: [
      {
        sourceOffset: style.contentOffset,
        generatedOffset: 0,
        length: style.content.length,
      },
    ],
  }
}

function push(
  mappings: VirtualMapping[],
  sourceOffset: number,
  generatedOffset: number,
  length: number,
): void {
  if (length > 0) mappings.push({ sourceOffset, generatedOffset, length })
}
