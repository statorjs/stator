// Minimal TS-on-import loader for the `stator` CLI, so the plain-`node` bin can
// import the framework's TypeScript source without a `tsx` dependency. Uses
// esbuild (already a framework dep) to strip/transform types at load time.
// Synchronous, in-thread hooks for `module.registerHooks`.
//
// It intentionally handles only `.ts`/`.tsx` — `.stator` is compiled by the
// dev loader (`server/dev-loader.ts`) and the build, not here.
import { readFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const TS = /\.(?:ts|tsx|mts|cts)$/

/** Tell Node a `.ts` URL is an ES module so it reaches the `load` hook instead
 *  of throwing ERR_UNKNOWN_FILE_EXTENSION. Imports carry explicit extensions
 *  (framework convention), so no specifier rewriting is needed. */
export function resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context)
  if (TS.test(new URL(result.url).pathname))
    return { ...result, format: 'module', shortCircuit: true }
  return result
}

/** Transform TS source to ESM JS at load time. */
export function load(url, context, nextLoad) {
  if (url.startsWith('file:') && TS.test(new URL(url).pathname)) {
    const path = fileURLToPath(url)
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

let registered = false

/** Register the hooks on this thread, once. */
export function registerTsLoader() {
  if (registered) return
  registered = true
  nodeModule.registerHooks({ resolve, load })
}
