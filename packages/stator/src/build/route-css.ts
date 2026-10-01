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

interface Reached {
  local: Set<string>
  external: Set<string>
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
 *  everywhere else (`copy-set.ts`). */
async function externalCss(specifier: string, fromDir: string): Promise<string | undefined> {
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
    const reached: Reached = { local: new Set(), external: new Set() }
    await walkReachable(routeFile, baseDir, new Set(), reached)
    let css = ''
    for (const file of [...reached.local].sort()) {
      const text = await siblingCss(file)
      if (text) css += `/* ${relFrom(baseDir, file)} */\n${text}\n`
    }
    for (const spec of [...reached.external].sort()) {
      const text = await externalCss(spec, baseDir)
      if (text) css += `/* ${spec} */\n${text}\n`
    }
    if (css) out.set(routeFile, css)
  }
  return out
}
