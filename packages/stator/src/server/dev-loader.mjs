// Native dev-server module loader: esbuild TS-on-import (like the CLI's shipped
// `cli/loader.js`) PLUS app-scoped `?v=` propagation — the piece the Vite-free
// dev loop needs that the prod loader does not.
//
// Invalidation model: the dev server imports a changed entry with a bumped
// `?v=N` cache-buster. This loader propagates that `?v=N` through `resolve` onto
// the entry's app-relative imports, so a single bumped entry re-imports its WHOLE
// transitive graph (templates, lib) fresh — not just the entry module. Without
// propagation a `route → layout` edit stays cached (proven in Spike D).
//
// The propagation boundary is CRITICAL and an allowlist, not a denylist: it
// applies ONLY under the app's compiled output dir (`initialize({ appDir })`).
// Versioning framework internals would fork their singletons (render context,
// registries) into a second instance and break `read()` — the same dual-instance
// hazard as the old Vite fence, from the other side. A denylist on `node_modules`
// is unsafe under pnpm (symlinks realpath the framework OUT of node_modules), so
// we allowlist the app dir instead.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const TS = /\.(?:ts|tsx|mts|cts)$/

/** Absolute file path (no trailing sep) under which `?v=` propagation applies.
 *  Set by the dev server via register data; unset ⇒ this loader behaves exactly
 *  like the prod TS loader (no propagation). */
let appDir

export async function initialize(data) {
  appDir = data?.appDir
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  const url = new URL(result.url)
  if (!TS.test(url.pathname)) return result

  // Inherit the importer's build version onto app-relative children so the whole
  // app graph re-imports fresh on a bumped build. Scoped to `appDir`.
  if (appDir && url.protocol === 'file:' && context.parentURL) {
    const childPath = fileURLToPath(url)
    if (childPath.startsWith(appDir)) {
      const pv = new URL(context.parentURL).searchParams.get('v')
      if (pv && !url.searchParams.has('v')) {
        url.searchParams.set('v', pv)
        return { url: url.href, format: 'module', shortCircuit: true }
      }
    }
  }
  return { ...result, format: 'module', shortCircuit: true }
}

export async function load(url, context, nextLoad) {
  // `.pathname` strips the `?v=` query for the extension check, and
  // `fileURLToPath` ignores the query, so cache-busted URLs read the real file.
  if (url.startsWith('file:') && TS.test(new URL(url).pathname)) {
    const path = fileURLToPath(url)
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
