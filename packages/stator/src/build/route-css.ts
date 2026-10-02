import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { walkFiles } from './islands.ts'

/**
 * Per-route, usage-driven scoped CSS (spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`).
 *
 * Mirrors `routeIslandMap`'s shape exactly — a separate walk per route file,
 * because genuine per-route granularity is cheaper as N small walks than one
 * combined esbuild pass with per-entry attribution. The walk itself is
 * origin-blind: a reached module's CSS comes from its sibling `.css` file,
 * resolved either as a plain filesystem sibling (local, in-tree) or through
 * Node's module resolution (a `node_modules` package declaring
 * `${specifier}.css` in its `exports` map) — one lookup, same shape, because by
 * the time this runs, local production output and a published library's
 * output are the identical shape: a compiled module plus a sibling `.css`.
 * `node_modules` stays opaque beyond that one resolution — a bare specifier is
 * recorded and resolved for its OWN sibling stylesheet, never traced into.
 *
 * "Reached" is static import-graph reachability, not render-tracing: a
 * component used only inside an inactive `match`/`when`/`each` arm is still
 * reached, because a live SSE update can activate that arm later with no
 * fresh HTTP request
 * (`conditional-arm-interiors-are-second-class-on-the-live-update-path`) — its
 * CSS must already be present at the route's first paint. Do not narrow this
 * to what a given render actually produced.
 */

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

export interface Reached {
  local: Set<string>
  external: Set<string>
}

/** Strip `/* *\/` and `//` comments before scanning for import specifiers — a
 *  doc-comment usage example (`*   import { X } from 'pkg'`, an entirely
 *  normal pattern; this codebase's own `json-ld.ts` has one) must never be
 *  mistaken for a real import. Tracks string/template-literal state so a `//`
 *  or `/*` INSIDE one (a URL, say) is left alone, and respects backslash
 *  escapes inside strings. Not a full tokenizer — doesn't walk into a
 *  template literal's `${...}` interpolation — but errs toward
 *  under-stripping on anything it's unsure about: a surviving comment risks
 *  one false-positive specifier, not mangled real code. */
function stripComments(code: string): string {
  let out = ''
  let i = 0
  let inString: '"' | "'" | '`' | null = null
  while (i < code.length) {
    const c = code[i]!
    const next = code[i + 1]
    if (inString) {
      out += c
      if (c === '\\' && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (c === inString) inString = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      i = nl === -1 ? code.length : nl
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** A file's import specifiers, split by kind. Relative specifiers are resolved
 *  and bounded to `baseDir` (exactly `localImports`'s contract in
 *  `islands.ts`); bare specifiers are recorded verbatim and never resolved
 *  here — resolving one is a separate, explicit step (`externalCss`), and
 *  nothing follows a bare specifier's own imports. A static regex read, no
 *  module evaluation. */
async function importsOf(
  file: string,
  baseDir: string,
): Promise<{ local: string[]; external: string[] }> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return { local: [], external: [] }
  }
  code = stripComments(code)
  const local: string[] = []
  const external: string[] = []
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1]!
    if (spec.startsWith('.')) {
      const target = resolve(file, '..', spec)
      if (target.startsWith(baseDir)) local.push(target)
    } else if (!spec.startsWith('node:')) {
      external.push(spec)
    }
  }
  return { local, external }
}

/** A file's DIRECT bare-specifier imports only — no recursion, no relative
 *  resolution. The per-file primitive `dev-native.ts`'s incremental graph
 *  tracking reuses: the union of this over every app file (which it already
 *  walks for its own local import graph) equals the full set of packages the
 *  app reaches, the same thing `reachableFrom`'s recursive walk arrives at
 *  for one entry point. */
export async function bareSpecifiersOf(file: string): Promise<string[]> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return []
  }
  code = stripComments(code)
  const external: string[] = []
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1]!
    if (!spec.startsWith('.') && !spec.startsWith('node:')) external.push(spec)
  }
  return external
}

async function walkReachable(
  file: string,
  baseDir: string,
  seen: Set<string>,
  out: Reached,
): Promise<void> {
  if (seen.has(file)) return
  seen.add(file)
  out.local.add(file)
  const { local, external } = await importsOf(file, baseDir)
  for (const spec of external) out.external.add(spec)
  for (const target of local) await walkReachable(target, baseDir, seen, out)
}

/** Every local file and bare specifier reachable from one entry file's import
 *  graph — the shared primitive behind per-route CSS (`routeCssMap`), a
 *  library's publish-time barrel aggregation (`entryCss`), and anything else
 *  that needs "what does this file's graph reach." */
export async function reachableFrom(entryFile: string, baseDir: string): Promise<Reached> {
  const reached: Reached = { local: new Set(), external: new Set() }
  await walkReachable(resolve(entryFile), resolve(baseDir), new Set(), reached)
  return reached
}

/** A reached local module's sibling CSS — `foo.ts` → `foo.css` next to it.
 *  Written by the same compile step that produced `foo.ts` (the production
 *  build; a library's publish-time compile is the identical operation run
 *  over its own source). Not every reached module is a compiled component —
 *  most simply have no sibling, which is a silent, expected miss. */
async function siblingCss(file: string): Promise<string | undefined> {
  const cssPath = file.replace(/\.(ts|js)$/, '.css')
  if (cssPath === file) return undefined
  try {
    return await readFile(cssPath, 'utf8')
  } catch {
    return undefined
  }
}

/** A bare specifier's published sibling stylesheet, if its package declares
 *  one at `${specifier}.css` in its `exports` map. Resolved once; never
 *  recursed into — `node_modules` stays opaque beyond this one lookup, same
 *  invariant that already governs how the build treats dependencies
 *  everywhere else (`copy-set.ts`). Exported so `dev-native.ts` can resolve
 *  the same way for its own (non-per-route) CSS aggregate. */
export async function externalCss(specifier: string, fromDir: string): Promise<string | undefined> {
  try {
    const require = createRequire(resolve(fromDir, 'noop.cjs'))
    const path = require.resolve(`${specifier}.css`)
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function relFrom(baseDir: string, file: string): string {
  return file.slice(baseDir.length + 1).replace(/\\/g, '/')
}

/** Collect the sibling CSS of everything in a `Reached` set, local and
 *  external alike — one algorithm, no branching on origin. */
async function cssOf(reached: Reached, baseDir: string): Promise<string> {
  let css = ''
  for (const file of [...reached.local].sort()) {
    const text = await siblingCss(file)
    if (text) css += `/* ${relFrom(baseDir, file)} */\n${text}\n`
  }
  for (const spec of [...reached.external].sort()) {
    const text = await externalCss(spec, baseDir)
    if (text) css += `/* ${spec} */\n${text}\n`
  }
  return css
}

/**
 * Walk each route file's import graph and collect the sibling CSS of every
 * reached module, local or external. Returns absolute route file → one
 * concatenated stylesheet, only for routes that reached any CSS at all.
 */
export async function routeCssMap(opts: {
  routesDir: string
  baseDir: string
}): Promise<Map<string, string>> {
  const baseDir = resolve(opts.baseDir)
  const routeFiles = await walkFiles(opts.routesDir, (f) => /\.(ts|js|stator)$/.test(f)).catch(
    () => [] as string[],
  )
  const out = new Map<string, string>()
  for (const routeFile of routeFiles) {
    const reached = await reachableFrom(routeFile, baseDir)
    const css = await cssOf(reached, baseDir)
    if (css) out.set(routeFile, css)
  }
  return out
}

/**
 * The same walk, rooted at a SINGLE entry file instead of every file in a
 * routes/ directory — for a `.stator` component library's own publish-time
 * compile, aggregating the CSS reachable from one public entry point (e.g.
 * its `components` barrel) into one sibling stylesheet matching that entry's
 * own published specifier (`components/index.ts` → `components.css`, resolved
 * by a consumer the same way any other reached module's CSS is).
 */
export async function entryCss(entryFile: string, baseDir: string): Promise<string> {
  const reached = await reachableFrom(entryFile, baseDir)
  return cssOf(reached, baseDir)
}
