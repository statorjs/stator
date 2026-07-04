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

const TEMPLATE_IMPORTS =
  "import { read, each, when, match, on, classList, styleList, raw } from '@statorjs/stator/template';\n"
const CLIENT_IMPORTS =
  "import { StatorElement, use, machine, defineElement, bind, effect, dispatch } from '@statorjs/stator/client';\n"
// Aliased so they never collide with a component's own `InstanceOf` import.
const AMBIENT_TYPE_IMPORTS =
  "import type { InstanceOf as __SInstanceOf, AnyMachineDef as __SMachineDef } from '@statorjs/stator/machine';\n"

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

/** Server component: frontmatter (module scope) + template as a JSX fragment, so
 *  template expressions see the frontmatter's bindings. */
function buildServerTsx(regions: ScannedRegions): VirtualFile {
  const mappings: VirtualMapping[] = []
  let code = TEMPLATE_IMPORTS + AMBIENT_TYPE_IMPORTS + STATOR_AMBIENT

  if (regions.frontmatter?.content.trim()) {
    push(
      mappings,
      regions.frontmatter.contentOffset,
      code.length,
      regions.frontmatter.content.length,
    )
    code += `${regions.frontmatter.content}\n`
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
  // './x.stator'`) and puts the template in a scope that closes over the
  // frontmatter bindings. The param is typed from `Stator.props<P>()` (same
  // extraction as the .d.ts generator), so `<Component bad={...}/>` in OTHER
  // .stator files is checked in-editor — TS validates value-based JSX against
  // the component function's first parameter. Named prop types resolve
  // because the frontmatter is emitted into this same module above.
  const propsT = componentPropsType(
    extractFrontmatterTypes(regions.frontmatter?.content ?? '').propsType,
    regions.template.content,
  )
  code += `export default function (_props: ${propsT}) {\n  return (<>`
  push(mappings, tplOffset, code.length, tpl.length)
  code += tpl
  code += '</>);\n}\n'

  return { lang: 'tsx', code, mappings }
}

/** Client component: the `<script>` is the module. Emit it as TS so the class,
 *  `use()`/`machine()`, and imports get full intelligence. (Template-member
 *  resolution — `bind:text={theme.label}` → the class field — is a later phase.) */
function buildClientTsx(regions: ScannedRegions): VirtualFile {
  const mappings: VirtualMapping[] = []
  let code = TEMPLATE_IMPORTS + CLIENT_IMPORTS + AMBIENT_TYPE_IMPORTS + STATOR_AMBIENT

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
