// Native dev-server module loader: synchronous, in-thread hooks for
// `module.registerHooks`. Three jobs:
//
//  1. `.stator` compile-on-load: a `.stator` import is read from the SOURCE tree,
//     compiled by the framework compiler (server render module), and type-
//     stripped by esbuild. No mirror, no on-disk `.stator.ts` — the server runs
//     from the app's real files, so `import.meta.url`-relative paths (a SQLite
//     file, a data dir) mean the same thing in dev as in the app's source.
//  2. TS-on-import, like the CLI's shipped `cli/loader.js`.
//  3. App-scoped `?v=` propagation — the one piece the prod loader lacks.
//
// Invalidation model — importer-only: every app module is imported at
// `?v=<its own version>`. The dev server keeps a per-file version map, bumps
// a changed file AND its transitive importers (a static reverse import graph),
// and re-imports entries. The hooks read that same map, so `resolve` stamps
// each app-local child with its current version: a changed subtree
// re-evaluates fresh while everything else keeps its cached module instance —
// a `lib/db.ts` that opens a connection at top level runs once per session,
// not once per edit, and the ESM registry (which never releases a module)
// grows by the affected subtree instead of the whole app.
//
// The versioning boundary is CRITICAL: it applies only to files under the app
// root (`appDir`) and never inside a `node_modules` directory. Versioning
// framework internals would fork their singletons (render context,
// registries) into a second instance and break `read()`. Both checks are
// needed: under pnpm the framework realpaths OUT of node_modules (so the app-
// root allowlist catches it), under a flat install it sits INSIDE the app root
// (so the node_modules denylist catches it).
import { readFileSync } from 'node:fs'
import {
  type LoadHookSync,
  type ModuleHooks,
  type ResolveHookSync,
  registerHooks,
} from 'node:module'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { sourceId } from '../build/source-id.ts'
import { CompileError, compile, formatCompileError, regionResolverFor } from '../compiler/index.ts'

const TS = /\.(?:ts|tsx|mts|cts)$/
const STATOR = /\.stator$/
/** Extensions whose app-local imports carry the build version. */
const VERSIONED = /\.(?:stator|ts|tsx|mts|cts|js|mjs)$/

export interface DevLoaderOptions {
  /** Absolute (real) app root under which versioning applies. Unset ⇒ the
   *  hooks behave like the prod TS loader plus `.stator` compile. */
  appDir?: string
  /** Absolute file path → current version, owned by the dev server. */
  versions?: ReadonlyMap<string, number>
}

/** The dev loader's `resolve` and `load` hooks over the given options. */
export function devLoaderHooks({ appDir, versions = new Map() }: DevLoaderOptions = {}): {
  resolve: ResolveHookSync
  load: LoadHookSync
} {
  const inApp = (path: string): boolean =>
    Boolean(appDir) && path.startsWith(appDir + sep) && !path.includes(`${sep}node_modules${sep}`)

  const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
    const result = nextResolve(specifier, context)
    const url = new URL(result.url)
    const own = TS.test(url.pathname) || STATOR.test(url.pathname)
    const format = own ? 'module' : result.format
    if (!VERSIONED.test(url.pathname) || format !== 'module') return result

    // Stamp an app-local module with its current version (entries arrive already
    // stamped by the dev server; children get theirs here).
    if (url.protocol === 'file:' && !url.searchParams.has('v')) {
      const path = fileURLToPath(url)
      if (inApp(path)) {
        url.searchParams.set('v', String(versions.get(path) ?? 1))
        return { url: url.href, format, shortCircuit: true }
      }
    }
    return own ? { ...result, format, shortCircuit: true } : result
  }

  const load: LoadHookSync = (url, context, nextLoad) => {
    if (!url.startsWith('file:')) return nextLoad(url, context)
    // `fileURLToPath` ignores the `?v=` query, so cache-busted URLs read the real file.
    const path = fileURLToPath(url)

    if (STATOR.test(path)) {
      const source = readFileSync(path, 'utf8')
      const { id, kind }: { id: string; kind: 'route' | 'component' } = appDir
        ? sourceId(appDir, path)
        : { id: path, kind: /[\\/]routes[\\/]/.test(path) ? 'route' : 'component' }
      let result: ReturnType<typeof compile>
      try {
        result = compile(source, {
          id,
          kind,
          resolveRegions: regionResolverFor(path, source),
          // esbuild chains this map through its transform below, so stack traces
          // and breakpoints land on the .stator file itself.
          sourceMap: { source: path },
        })
      } catch (err) {
        // The importer sees file:line:column and the code frame in the message.
        throw err instanceof CompileError ? new Error(formatCompileError(err)) : err
      }
      const { code } = transformSync(result.serverCode, {
        loader: 'ts',
        format: 'esm',
        target: 'node20',
        sourcemap: 'inline',
        sourcefile: path,
      })
      return { format: 'module', source: code, shortCircuit: true }
    }

    if (TS.test(path)) {
      const { code } = transformSync(readFileSync(path, 'utf8'), {
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

  return { resolve, load }
}

/** Register the dev loader on this thread; `deregister()` on the handle removes it. */
export function registerDevLoader(options: DevLoaderOptions): ModuleHooks {
  return registerHooks(devLoaderHooks(options))
}
