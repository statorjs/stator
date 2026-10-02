import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { walkFiles } from './islands.ts'

/**
 * Per-route scoped CSS (spec
 * `stator-component-libraries-publish-time-compile-per-component-scoped-css-usage-driven-aggregation`).
 * A separate reachability walk per route file. A reached module's CSS comes
 * from its sibling `.css` file, resolved as a filesystem sibling (local) or
 * through Node's module resolution (a `node_modules` package declaring
 * `${specifier}.css` in its `exports` map) — `node_modules` is never traced
 * beyond that one resolution.
 *
 * "Reached" is static import-graph reachability, not render-tracing: a
 * component used only inside an inactive `match`/`when`/`each` arm is still
 * reached, since a live SSE update can activate that arm later with no fresh
 * HTTP request — its CSS must already be present at the route's first paint.
 */

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

export interface Reached {
  local: Set<string>
  external: Set<string>
}

/** Strip `/* *\/` and `//` comments before scanning for import specifiers,
 *  so a doc-comment usage example isn't mistaken for a real import. Tracks
 *  string/template-literal state so a `//` or `/*` inside one is left alone.
 *  Not a full tokenizer (doesn't walk into `${...}` interpolation); errs
 *  toward under-stripping. */
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

/** A file's import specifiers, split by kind. Relative specifiers are
 *  resolved and bounded to `baseDir`; bare specifiers are recorded verbatim,
 *  never resolved or traced further here. */
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

/** A file's direct bare-specifier imports only — no recursion, no relative
 *  resolution. Used by `dev-native.ts`'s incremental graph tracking. */
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

/** Every local file and bare specifier reachable from one entry file's
 *  import graph. */
export async function reachableFrom(entryFile: string, baseDir: string): Promise<Reached> {
  const reached: Reached = { local: new Set(), external: new Set() }
  await walkReachable(resolve(entryFile), resolve(baseDir), new Set(), reached)
  return reached
}

/** A reached local module's sibling CSS — `foo.ts` → `foo.css`. Most reached
 *  modules have no sibling; that's a silent, expected miss. */
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
 *  one at `${specifier}.css` in its `exports` map. */
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

/** The same walk, rooted at a single entry file instead of a routes/
 *  directory — e.g. a component library's own `components.css`. */
export async function entryCss(entryFile: string, baseDir: string): Promise<string> {
  const reached = await reachableFrom(entryFile, baseDir)
  return cssOf(reached, baseDir)
}
