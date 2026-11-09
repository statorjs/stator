import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { probeModule, scanImports } from './imports.ts'

/**
 * The island-bundling seam.
 *
 * `bundleIslands` is a pure inputs→outputs function: island entries in; emitted
 * files, a rel→URL map, and the list of source modules that went in, out.
 * Nothing is written or served here — `buildApp` writes the assets under
 * `dist/static/assets/`, the native dev server keeps them in memory. That is
 * what keeps the bundler one implementation with the same core feeding both
 * sides.
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

/**
 * The seam's one export. esbuild bundles islands in dev and in the production
 * build alike (`islands-esbuild.ts`); the seam stays a function so a future
 * bundler is one implementation behind the same contract tests.
 */
export const bundleIslands: IslandBundler = async (opts) => {
  const { bundleIslandsEsbuild } = await import('./islands-esbuild.ts')
  return bundleIslandsEsbuild(opts)
}

/**
 * Per-route island reachability: which islands each route file's import graph
 * reaches (`reachability.ts`). `shells` maps an app island's server-side
 * module (the `.stator` source in dev, the compiled `.stator.ts` in dist) to
 * its rel; islands inside packages are found by the sibling rule and named
 * `@pkg/path/x.stator` (`library-islands.ts`, which also returns them).
 * Returns absolute route file → sorted island rels, only for routes that
 * reach at least one island.
 */
export async function routeIslandMap(opts: {
  routesDir: string
  baseDir: string
  shells: Map<string, string>
}): Promise<Map<string, string[]>> {
  const { reachIslands } = await import('./library-islands.ts')
  return (await reachIslands(opts)).routes
}

/** Absolute targets of a file's relative import specifiers, bounded to
 *  `baseDir`: a static read through `imports.ts`, no module evaluation (an
 *  unreadable file yields none). An extensionless specifier is probed the way
 *  `probeModule` does. */
export async function localImports(file: string, baseDir: string): Promise<string[]> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const { spec } of scanImports(code, file)) {
    if (!spec.startsWith('.')) continue
    const base = resolve(join(file, '..'), spec)
    const target = probeModule(base) ?? base
    if (target.startsWith(baseDir)) out.push(target)
  }
  return out
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
