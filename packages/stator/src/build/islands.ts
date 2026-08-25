import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Rollup } from 'vite'

/**
 * The island-bundling seam — Lock 1 of the Vite exit (spec
 * `toolchain-adapter-seam-and-the-vite-exit`).
 *
 * `bundleIslands` is a pure inputs→outputs function: island entries in; emitted
 * files, a rel→URL map, and the list of source modules that went in, out.
 * Nothing is written or served here — `buildApp` writes the assets under
 * `dist/static/assets/`, the native dev server keeps them in memory. That is
 * what makes the bundler a one-implementation swap (Vite today; esbuild is the
 * Option E candidate) with the same core feeding both sides.
 *
 * The entry contract is deliberately tiny: an entry is either the island's
 * `.stator` SOURCE (the bundler compiles its `<script>` to the client module)
 * or a prebuilt client entry module. Server-machine imports inside an island
 * collapse to `{ name }` identity stubs; the machine body never ships.
 */

export interface IslandEntry {
  /** App-relative `.stator` path, `/`-separated — the island's manifest identity. */
  rel: string
  /** Absolute entry file: the `.stator` source, or a prebuilt client entry. */
  file: string
}

export interface IslandAsset {
  /** Path relative to the assets root (entries, shared chunks, emitted assets). */
  fileName: string
  source: string | Uint8Array
}

export interface IslandBundle {
  /** Island rel → public URL of its entry script. */
  islandUrls: Record<string, string>
  assets: IslandAsset[]
  /** Absolute path of every source module in the bundle (queries and stub
   *  prefixes stripped, `/`-separated) — lets a watcher decide whether an edit
   *  needs a rebundle without knowing anything about the bundler. */
  modules: string[]
}

export interface BundleIslandsOptions {
  /** Resolution root (the app dir, or dist) — must reach node_modules. */
  root: string
  /** Directory whose modules are stubbed to `{ name }` in browser bundles. */
  machinesDir: string
  entries: IslandEntry[]
  /** URL prefix the assets are served under. Default `/static/assets/`. */
  publicPath?: string
  /** Seam contract: `true` appends an INLINE sourcemap to each emitted chunk
   *  (a `sourceMappingURL=data:` comment — self-contained, so in-memory dev
   *  serving needs no extra `.map` routes and browser devtools show island
   *  source). Default off — production bundles ship unmapped. */
  sourcemap?: boolean
}

export type IslandBundler = (opts: BundleIslandsOptions) => Promise<IslandBundle>

const norm = (p: string): string => p.replace(/\\/g, '/')
const stripQuery = (id: string): string => {
  const q = id.indexOf('?')
  return q === -1 ? id : id.slice(0, q)
}

/** Implementation #1: one Vite build over every island entry. Vite is imported
 *  lazily — server-only apps never load it. */
export const bundleIslands: IslandBundler = async (opts) => {
  const [{ build: viteBuild }, { CLIENT_QUERY, MACHINE_STUB_PREFIX, machineStub, stator }] =
    await Promise.all([import('vite'), import('../vite/index.ts')])
  const publicPath = opts.publicPath ?? '/static/assets/'

  const input: Record<string, string> = {}
  const byFile = new Map<string, IslandEntry>()
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
      // as a data: URL — deterministic for callers and identical to what an
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

/**
 * Per-route island reachability: walk each route file's relative-import graph
 * (bounded to `baseDir`) and record which island shells it reaches. `shells`
 * maps an island's server-side module file (the `.stator` source in dev, the
 * compiled `.stator.ts` in dist) to the island's rel. Returns absolute route
 * file → sorted island rels, only for routes that reach at least one island.
 */
export async function routeIslandMap(opts: {
  routesDir: string
  baseDir: string
  shells: Map<string, string>
}): Promise<Map<string, string[]>> {
  const baseDir = resolve(opts.baseDir)
  const routes = new Map<string, string[]>()
  const routeFiles = await walkFiles(opts.routesDir, (f) => /\.(ts|js|stator)$/.test(f)).catch(
    () => [] as string[],
  )
  for (const routeFile of routeFiles) {
    const reached = new Set<string>()
    await walkImports(routeFile, baseDir, new Set(), (file) => {
      const island = opts.shells.get(file)
      if (island) reached.add(island)
    })
    if (reached.size > 0) routes.set(routeFile, [...reached].sort())
  }
  return routes
}

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** Absolute targets of a file's relative import specifiers, bounded to
 *  `baseDir` (a static regex read — no module evaluation; an unreadable file
 *  yields none). Specifiers carry explicit extensions by convention. */
export async function localImports(file: string, baseDir: string): Promise<string[]> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1]!
    if (!spec.startsWith('.')) continue
    const target = resolve(join(file, '..'), spec)
    if (target.startsWith(baseDir)) out.push(target)
  }
  return out
}

/** Depth-first walk of a file's relative-import graph, bounded to `baseDir`. */
export async function walkImports(
  file: string,
  baseDir: string,
  seen: Set<string>,
  visit: (file: string) => void,
): Promise<void> {
  if (seen.has(file)) return
  seen.add(file)
  visit(file)
  for (const target of await localImports(file, baseDir)) {
    await walkImports(target, baseDir, seen, visit)
  }
}

/** Recursive file listing. `skipDir` prunes a directory by name. */
export async function walkFiles(
  dir: string,
  match: (file: string) => boolean,
  skipDir?: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (skipDir?.(e.name)) continue
      out.push(...(await walkFiles(full, match, skipDir)))
    } else if (match(full)) out.push(full)
  }
  return out
}
