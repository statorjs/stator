// Minimal TS-on-import loader for the `stator` CLI, so the plain-`node` bin can
// import the framework's TypeScript source without a `tsx` dependency. Uses
// esbuild (already a framework dep) to strip/transform types at load time.
//
// This is the seed of Stator's own thin toolchain glue: the same shape a
// `.stator` `node:test` loader hook will take later. It intentionally handles
// only `.ts`/`.tsx` — `.stator` is compiled by the framework's own compiler on
// the dev/build path, not here.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const TS = /\.(?:ts|tsx|mts|cts)$/

/** Tell Node a `.ts` URL is an ES module so it reaches the `load` hook instead
 *  of throwing ERR_UNKNOWN_FILE_EXTENSION. Imports carry explicit extensions
 *  (framework convention), so no specifier rewriting is needed. */
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (TS.test(new URL(result.url).pathname))
    return { ...result, format: 'module', shortCircuit: true }
  return result
}

/** Transform TS source to ESM JS at load time. */
export async function load(url, context, nextLoad) {
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
