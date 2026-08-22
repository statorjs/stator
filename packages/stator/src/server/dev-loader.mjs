// Native dev-server module loader — the Vite exit's dev half. Three jobs, all
// on Node's module-customization hooks thread:
//
//  1. `.stator` compile-on-load: a `.stator` import is read from the SOURCE tree,
//     compiled by the framework compiler (server render module), and type-
//     stripped by esbuild. No mirror, no on-disk `.stator.ts` — the server runs
//     from the app's real files, so `import.meta.url`-relative paths (a SQLite
//     file, a data dir) mean the same thing in dev as in the app's source.
//  2. TS-on-import, like the CLI's shipped `cli/loader.js`.
//  3. App-scoped `?v=` propagation — the one piece the prod loader lacks.
//
// Invalidation model: the dev server imports a changed entry with a bumped
// `?v=N` cache-buster. This loader propagates that `?v=N` through `resolve`
// onto the entry's app-relative imports, so a single bumped entry re-imports
// its WHOLE transitive graph (templates, lib) fresh — not just the entry module.
// Without propagation a `route → layout` edit stays cached (proven in Spike D).
//
// The propagation boundary is CRITICAL: it applies only to files under the app
// root (`initialize({ appDir })`) and never inside a `node_modules` directory.
// Versioning framework internals would fork their singletons (render context,
// registries) into a second instance and break `read()` — the same dual-
// instance hazard as the old Vite fence, from the other side. Both checks are
// needed: under pnpm the framework realpaths OUT of node_modules (so the app-
// root allowlist catches it), under a flat install it sits INSIDE the app root
// (so the node_modules denylist catches it).
//
// This module imports the TypeScript compiler source, so it must be registered
// after a TS loader (the dev server registers `cli/loader.js` first).
import { readFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'
import { sourceId } from '../build/source-id.ts'
import { CompileError, compile, formatCompileError, regionResolverFor } from '../compiler/index.ts'

const TS = /\.(?:ts|tsx|mts|cts)$/
const STATOR = /\.stator$/
/** Extensions whose app-local imports carry the build version. */
const VERSIONED = /\.(?:stator|ts|tsx|mts|cts|js|mjs)$/

/** Absolute app root under which `?v=` propagation applies. Unset ⇒ this loader
 *  behaves like the prod TS loader plus `.stator` compile (no propagation). */
let appDir

export async function initialize(data) {
  appDir = data?.appDir
}

const inApp = (path) =>
  Boolean(appDir) && path.startsWith(appDir + sep) && !path.includes(`${sep}node_modules${sep}`)

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  const url = new URL(result.url)
  const own = TS.test(url.pathname) || STATOR.test(url.pathname)
  const format = own ? 'module' : result.format
  if (!VERSIONED.test(url.pathname) || format !== 'module') return result

  // Inherit the importer's build version onto app-local children so the whole
  // app graph re-imports fresh on a bumped build.
  if (url.protocol === 'file:' && context.parentURL && inApp(fileURLToPath(url))) {
    const pv = new URL(context.parentURL).searchParams.get('v')
    if (pv && !url.searchParams.has('v')) {
      url.searchParams.set('v', pv)
      return { url: url.href, format, shortCircuit: true }
    }
  }
  return own ? { ...result, format, shortCircuit: true } : result
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context)
  // `fileURLToPath` ignores the `?v=` query, so cache-busted URLs read the real file.
  const path = fileURLToPath(url)

  if (STATOR.test(path)) {
    const source = await readFile(path, 'utf8')
    const { id, kind } = appDir
      ? sourceId(appDir, path)
      : { id: path, kind: /[\\/]routes[\\/]/.test(path) ? 'route' : 'component' }
    let result
    try {
      result = compile(source, { id, kind, resolveRegions: regionResolverFor(path, source) })
    } catch (err) {
      // Errors cross back to the main thread as plain Errors (custom props are
      // dropped), so bake file:line:column + the code frame into the message.
      throw err instanceof CompileError ? new Error(formatCompileError(err)) : err
    }
    const { code } = await transform(result.serverCode, {
      loader: 'ts',
      format: 'esm',
      target: 'node20',
      sourcemap: 'inline',
      sourcefile: path,
    })
    return { format: 'module', source: code, shortCircuit: true }
  }

  if (TS.test(path)) {
    const source = await readFile(path, 'utf8')
    const { code } = await transform(source, {
      loader: path.endsWith('x') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'node20',
      sourcemap: 'inline',
      sourcefile: path,
    })
    return { format: 'module', source: code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
