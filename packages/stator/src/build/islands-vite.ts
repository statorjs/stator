import { resolve } from 'node:path'
import type { Rollup } from 'vite'
import type { BundleIslandsOptions, IslandAsset, IslandBundler } from './islands.ts'

const norm = (p: string): string => p.replace(/\\/g, '/')
const stripQuery = (id: string): string => {
  const q = id.indexOf('?')
  return q === -1 ? id : id.slice(0, q)
}

/** Implementation #1: one Vite build over every island entry. Vite is imported
 *  lazily — server-only apps never load it. */
export const bundleIslandsVite: IslandBundler = async (opts: BundleIslandsOptions) => {
  const [{ build: viteBuild }, { CLIENT_QUERY, MACHINE_STUB_PREFIX, machineStub, stator }] =
    await Promise.all([import('vite'), import('../vite/index.ts')])
  const publicPath = opts.publicPath ?? '/static/assets/'

  const input: Record<string, string> = {}
  const byFile = new Map<string, BundleIslandsOptions['entries'][number]>()
  for (const entry of opts.entries) {
    const file = resolve(entry.file)
    input[entry.rel.replace(/\.stator$/, '').replace(/[\\/]/g, '_')] = file.endsWith('.stator')
      ? `${file}?${CLIENT_QUERY}`
      : file
    byFile.set(norm(file), entry)
  }

  const result = await viteBuild({
    root: opts.root,
    // Assets referenced by URL from island code (`new URL(...)`, CSS `url()`)
    // render against `base`, so it must be where the assets are served from.
    base: publicPath,
    logLevel: 'warn',
    configFile: false,
    plugins: [stator(), machineStub({ machinesDir: resolve(opts.machinesDir) })],
    build: {
      write: false,
      // Seam contract: a URL-referenced asset (`new URL('./x.wasm',
      // import.meta.url)`) is always emitted as a hashed FILE, never inlined
      // as a data: URL — deterministic for callers and identical to what the
      // esbuild implementation (file loader) produces.
      assetsInlineLimit: 0,
      sourcemap: opts.sourcemap ? 'inline' : false,
      rollupOptions: {
        input,
        output: {
          entryFileNames: '[name]-[hash].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: '[name]-[hash][extname]',
        },
      },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).filter(
    (r): r is Rollup.RollupOutput => 'output' in r,
  )

  const islandUrls: Record<string, string> = {}
  const assets: IslandAsset[] = []
  const modules = new Set<string>()
  const sourcePathOf = (id: string): string | null => {
    const raw = id.startsWith(MACHINE_STUB_PREFIX) ? id.slice(MACHINE_STUB_PREFIX.length) : id
    if (raw.startsWith('\0')) return null
    return norm(stripQuery(raw))
  }
  for (const out of outputs) {
    for (const item of out.output) {
      if (item.type === 'chunk') {
        assets.push({ fileName: item.fileName, source: item.code })
        for (const id of Object.keys(item.modules)) {
          const p = sourcePathOf(id)
          if (p) modules.add(p)
        }
        if (item.isEntry && item.facadeModuleId) {
          const entry = byFile.get(norm(stripQuery(item.facadeModuleId)))
          if (entry) islandUrls[entry.rel] = publicPath + item.fileName
        }
      } else {
        assets.push({ fileName: item.fileName, source: item.source })
      }
    }
  }
  for (const entry of opts.entries) {
    if (!islandUrls[entry.rel])
      throw new Error(`stator: island "${entry.rel}" missing from the bundle output`)
  }
  return { islandUrls, assets, modules: [...modules] }
}
