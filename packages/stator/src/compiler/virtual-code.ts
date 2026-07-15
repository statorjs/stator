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
 * (`Stator`, JSX intrinsics — see `STATOR_AMBIENT`) is intentionally permissive
 * on JSX and refined against real in-editor feedback; the mappings are the
 * load-bearing part.
 */

import ts from 'typescript'
import { analyzeScriptClasses } from './client-script.ts'
import { componentPropsType, extractFrontmatterTypes } from './dts.ts'
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

// Must mirror the RUNTIME's auto-injected globals exactly (compile.ts
// PRIMITIVES_IMPORT / client-emit.ts): a name injected here but not at
// runtime hides a missing-import bug; a name in both collides with the
// author's legitimate import (`raw` is NOT a runtime global — authors
// import it — which is why it must not be in this list).
const TEMPLATE_GLOBALS = ['read', 'each', 'when', 'match', 'on', 'classList', 'styleList']
const CLIENT_GLOBALS = [
  'StatorElement',
  'use',
  'machine',
  'defineElement',
  'bind',
  'effect',
  'dispatch',
]

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

function injectImports(globals: string[], modulePath: string, userCode: string): string {
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
const AMBIENT_TYPE_IMPORTS =
  "import type { AnyMachineDef as __SMachineDef } from '@statorjs/stator/machine';\n" +
  "import type { InstanceOf as __SInstanceOf } from '@statorjs/stator/template';\n"

/**
 * Per-file ambient scaffold prepended to every virtual TSX. `Stator` (the macro
 * surface, module-scoped) makes `Stator.props`/`reads`/… resolve — `reads` typed
 * through `InstanceOf` so a route's bindings infer their machine instance types.
 * The **global** JSX namespace is permissive (`extends Record<string, any>`), so
 * directives + custom elements don't flood false errors; it must be `declare
 * global` because TS resolves `JSX.IntrinsicElements` globally, and `extends
 * Record` (rather than an own index signature) lets every file's copy merge
 * without a duplicate-index-signature clash. Real per-element JSX typing — the
 * Astro `astro-jsx.d.ts` approach — is a Phase 2 refinement.
 */
const STATOR_AMBIENT = `declare const Stator: {
  props<P>(): P;
  reads<const T extends readonly __SMachineDef[]>(defs: T): { -readonly [K in keyof T]: __SInstanceOf<T[K]> };
  request: any;
  response: { status: number; headers: Record<string, string>; cookies: any };
};
declare global {
  namespace JSX {
    interface IntrinsicElements extends Record<string, any> {}
  }
}
`

const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i

export function toVirtualCode(source: string): VirtualCodeResult {
  const regions = scanRegions(source)
  const isClient =
    regions.scripts.length > 0 &&
    analyzeScriptClasses(regions.scripts.map((s) => s.content).join('\n')).length > 0

  return {
    tsx: isClient ? buildClientTsx(regions) : buildServerTsx(regions),
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
function buildServerTsx(regions: ScannedRegions): VirtualFile {
  const mappings: VirtualMapping[] = []
  const fm = regions.frontmatter?.content ?? ''
  const fmOffset = regions.frontmatter?.contentOffset ?? 0
  const userCode = fm + regions.template.content
  let code =
    injectImports(TEMPLATE_GLOBALS, '@statorjs/stator/template', userCode) +
    AMBIENT_TYPE_IMPORTS +
    STATOR_AMBIENT

  const { hoisted, body } = splitFrontmatter(fm, fmOffset)
  for (const seg of hoisted) {
    push(mappings, seg.sourceOffset, code.length, seg.text.length)
    code += `${seg.text}\n`
  }

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
  const propsT = componentPropsType(extractFrontmatterTypes(fm).propsType, regions.template.content)
  code += `export default function (_props: ${propsT}) {\n`
  for (const seg of body) {
    code += '  '
    push(mappings, seg.sourceOffset, code.length, seg.text.length)
    code += `${seg.text}\n`
  }
  code += '  return (<>'
  push(mappings, tplOffset, code.length, tpl.length)
  code += tpl
  code += '</>);\n}\n'

  return { lang: 'tsx', code, mappings }
}

interface FmSegment {
  sourceOffset: number
  text: string
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
  for (const stmt of sf.statements) {
    const seg: FmSegment = { sourceOffset: fmOffset + stmt.getStart(sf), text: stmt.getText(sf) }
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
 *  `use()`/`machine()`, and imports get full intelligence. (Template-member
 *  resolution — `bind:text={theme.label}` → the class field — is a later phase.) */
function buildClientTsx(regions: ScannedRegions): VirtualFile {
  const mappings: VirtualMapping[] = []
  const userScript = regions.scripts.map((s) => s.content).join('\n')
  let code =
    injectImports(TEMPLATE_GLOBALS, '@statorjs/stator/template', userScript) +
    injectImports(CLIENT_GLOBALS, '@statorjs/stator/client', userScript) +
    AMBIENT_TYPE_IMPORTS +
    STATOR_AMBIENT

  for (const script of regions.scripts) {
    push(mappings, script.contentOffset, code.length, script.content.length)
    code += `${script.content}\n`
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
