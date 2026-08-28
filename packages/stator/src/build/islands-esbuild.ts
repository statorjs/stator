import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BundleIslandsOptions, IslandAsset, IslandBundler } from './islands.ts'

/**
 * Implementation #2 of the island-bundling seam (spike for Option E of the
 * Vite exit): one esbuild build over every island entry, `splitting: true` so
 * shared modules — the client runtime above all — land in shared chunks
 * instead of duplicating per island.
 *
 * Same contract as the Vite implementation in `islands.ts`: entries are
 * `.stator` sources (compiled to their client module here) or prebuilt client
 * entry modules; server-machine imports collapse to `{ name }` stubs; nothing
 * is written — callers own the assets.
 */

const norm = (p: string): string => p.replace(/\\/g, '/')

const STUB_NS = 'stator-machine-stub'

/** Extensions an island may reference by URL; emitted as hashed files (the
 *  seam contract — never inlined), mirroring Vite's `assetsInlineLimit: 0`. */
const FILE_LOADERS: Record<string, 'file'> = Object.fromEntries(
  ['.wasm', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2'].map((e) => [
    e,
    'file' as const,
  ]),
)

export const bundleIslandsEsbuild: IslandBundler = async (opts: BundleIslandsOptions) => {
  const [{ build }, { compile, regionResolverFor }] = await Promise.all([
    import('esbuild'),
    import('../compiler/index.ts'),
  ])
  const publicPath = opts.publicPath ?? '/static/assets/'
  const root = resolve(opts.root)
  const machinesDir = resolve(opts.machinesDir)
  const outDir = resolve(root, '.stator-island-out') // virtual — write: false
  const inMachinesDir = (abs: string): boolean =>
    abs === machinesDir || abs.startsWith(machinesDir + sep)

  const entryPoints = opts.entries.map((entry) => ({
    in: resolve(entry.file),
    out: entry.rel.replace(/\.stator$/, '').replace(/[\\/]/g, '_'),
  }))
  const byFile = new Map(opts.entries.map((e) => [norm(resolve(e.file)), e]))

  // Rollup/Vite rewrite `new URL('./x', import.meta.url)` to an emitted asset;
  // esbuild does not, so the seam does it here: each URL-referenced relative
  // asset becomes an import (the file loader emits it hashed and exports its
  // public URL, root-absolute under `publicPath`, so the `new URL` still
  // resolves). Only string-literal relative specifiers — same limit as Vite.
  const URL_ASSET_RE = /new\s+URL\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g
  const rewriteUrlAssets = (code: string): string => {
    let n = 0
    const imports: string[] = []
    const out = code.replace(URL_ASSET_RE, (_m, _q: string, spec: string) => {
      const id = `__stator_url_asset_${n++}`
      imports.push(`import ${id} from ${JSON.stringify(spec)}`)
      return `new URL(${id}, import.meta.url)`
    })
    return imports.length === 0 ? code : `${imports.join('\n')}\n${out}`
  }

  const statorPlugin = {
    name: 'stator-client',
    setup(b: import('esbuild').PluginBuild) {
      b.onLoad({ filter: /\.stator$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8')
        const kind = /[\\/]routes[\\/].*\.stator$/.test(args.path) ? 'route' : 'component'
        const result = compile(source, {
          id: args.path,
          kind,
          resolveRegions: regionResolverFor(args.path, source),
        })
        return {
          contents: result.isClient ? rewriteUrlAssets(result.clientCode) : 'export {}',
          loader: 'ts',
          resolveDir: dirname(args.path),
        }
      })
      b.onLoad({ filter: /\.(ts|mts|js|mjs)$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8')
        const rewritten = rewriteUrlAssets(source)
        if (rewritten === source) return undefined
        return {
          contents: rewritten,
          loader: args.path.endsWith('js') ? 'js' : 'ts',
          resolveDir: dirname(args.path),
        }
      })
    },
  }

  const machineStubPlugin = {
    name: 'stator-machine-stub',
    setup(b: import('esbuild').PluginBuild) {
      b.onResolve({ filter: /^[./]/ }, (args) => {
        if (args.namespace === STUB_NS) return null
        const base = isAbsolute(args.path) ? args.path : resolve(args.resolveDir, args.path)
        const abs = [base, `${base}.ts`, `${base}.js`].find(inMachinesDir)
        if (!abs) return null
        return { path: abs, namespace: STUB_NS }
      })
      b.onLoad({ filter: /.*/, namespace: STUB_NS }, async (args) => {
        let name: unknown
        try {
          const mod = (await import(pathToFileURL(args.path).href)) as {
            default?: { name?: unknown }
          }
          name = mod.default?.name
        } catch (err) {
          throw new Error(
            `stator: cannot stub server-machine import "${args.path}" for the client bundle — ` +
              `importing it in Node failed: ${(err as Error).message}`,
          )
        }
        if (typeof name !== 'string') {
          throw new Error(
            `stator: cannot stub "${args.path}" — it does not default-export a machine with a name. ` +
              `Only machine defs may be imported from the machines directory in client code.`,
          )
        }
        return { contents: `export default { name: ${JSON.stringify(name)} }\n`, loader: 'js' }
      })
    },
  }

  const result = await build({
    absWorkingDir: root,
    entryPoints,
    outdir: outDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    write: false,
    metafile: true,
    minify: true,
    publicPath,
    sourcemap: opts.sourcemap ? 'inline' : false,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: '[name]-[hash]',
    loader: FILE_LOADERS,
    logLevel: 'warning',
    plugins: [machineStubPlugin, statorPlugin],
  })

  const assets: IslandAsset[] = result.outputFiles.map((f) => {
    const fileName = norm(relative(outDir, f.path))
    return fileName.endsWith('.js')
      ? { fileName, source: f.text }
      : { fileName, source: f.contents }
  })

  const modules = new Set<string>()
  for (const key of Object.keys(result.metafile.inputs)) {
    if (key.startsWith(`${STUB_NS}:`)) modules.add(norm(key.slice(STUB_NS.length + 1)))
    else modules.add(norm(resolve(root, key)))
  }

  const islandUrls: Record<string, string> = {}
  for (const [outPath, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue
    const entry = byFile.get(norm(resolve(root, meta.entryPoint)))
    if (entry) islandUrls[entry.rel] = publicPath + norm(relative(outDir, resolve(root, outPath)))
  }
  for (const entry of opts.entries) {
    if (!islandUrls[entry.rel])
      throw new Error(`stator: island "${entry.rel}" missing from the bundle output`)
  }

  return { islandUrls, assets, modules: [...modules] }
}
