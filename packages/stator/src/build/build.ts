import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { compile } from '../compiler/index.ts'

/**
 * Production build: compile a `.stator` app to a `dist/` of plain `.ts` that the
 * existing `createApp` + tsx runtime serves with no Vite.
 *
 *   1. copy machines / routes / templates / static into dist
 *   2. compile each `*.stator` → a sibling `*.stator.ts`, delete the `.stator`,
 *      accumulate scoped CSS; for client components also write the generated
 *      client entry as a sibling `*.stator.client.ts`
 *   3. rewrite `.stator` import specifiers (`'./x.stator'` → `'./x.stator.ts'`)
 *   4. write the concatenated scoped CSS to `dist/static/components.css`
 *   5. when the app has client components: bundle every island entry in one
 *      Vite build (hashed output under `dist/static/assets/`, server-machine
 *      imports stubbed to `{ name }` via `machineStub`), walk each route's
 *      import graph to find which islands it reaches, and write
 *      `dist/stator-manifest.json` mapping route files → island script URLs
 *
 * The prod server runs `createApp` over `dist/` with the `headExtras` hook
 * from `loadProductionHead(dist)` — it links `components.css` and injects the
 * manifest's `<script type="module">` tags per route. File discovery + dynamic
 * import work unchanged on the precompiled output; Vite is needed only at
 * build time, and only when islands exist.
 */

export interface BuildConfig {
  /** App directory containing machines/ routes/ templates/ static/. */
  root: string
  /** Output directory. Wiped and recreated. */
  outDir: string
  /** Subdirectories to copy into dist. Defaults to every top-level directory
   *  in the app root except node_modules, tests, hidden dirs, and the outDir
   *  itself — machines and routes import freely from sibling dirs (lib/,
   *  data/), so dist must mirror the app's source shape. */
  dirs?: string[]
}

export interface BuildResult {
  outDir: string
  /** Number of `.stator` files compiled. */
  compiled: number
  /** True when any component produced scoped CSS (components.css written). */
  hasCss: boolean
  /** Number of client components bundled for the browser. */
  islands: number
}

/** Shape of `dist/stator-manifest.json` (only written when islands exist). */
export interface StatorManifest {
  /** Island component (dist-relative `.stator` path) → its script URL. */
  islands: Record<string, string>
  /** Route file (dist-relative) → script URLs for every island it reaches. */
  routes: Record<string, string[]>
}

const NEVER_COPY = new Set(['node_modules', 'tests', 'test', '__tests__'])

/** Every top-level directory that can hold app source. Machines/routes
 *  import from arbitrary sibling dirs, so dist mirrors the source tree. */
async function discoverSourceDirs(root: string, outDir: string): Promise<string[]> {
  const outBase = relative(root, outDir).split(sep)[0]
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith('.') && !NEVER_COPY.has(e.name) && e.name !== outBase,
    )
    .map((e) => e.name)
}

export async function buildApp(config: BuildConfig): Promise<BuildResult> {
  const root = resolve(config.root)
  const outDir = resolve(config.outDir)
  const dirs = config.dirs ?? (await discoverSourceDirs(root, outDir))

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const d of dirs) {
    const src = join(root, d)
    if (await exists(src)) await cp(src, join(outDir, d), { recursive: true })
  }

  // Compile every .stator into a sibling .stator.ts; collect CSS and islands.
  const statorFiles = await walk(outDir, (f) => f.endsWith('.stator'))
  let css = ''
  const islands: Array<{ rel: string; entry: string }> = []
  for (const file of statorFiles) {
    const source = await readFile(file, 'utf8')
    const rel = relative(outDir, file)
    const kind = /(^|[\\/])routes[\\/]/.test(rel) ? ('route' as const) : ('component' as const)
    const result = compile(source, { id: rel, kind })
    await writeFile(`${file}.ts`, result.serverCode)
    if (result.isClient) {
      // The generated client entry, written as a sibling so the authored
      // script's relative imports resolve against the mirrored dist tree.
      await writeFile(`${file}.client.ts`, result.clientCode)
      islands.push({ rel, entry: `${file}.client.ts` })
    }
    await rm(file)
    if (result.css) css += `/* ${rel} */\n${result.css}\n`
  }

  // Rewrite `.stator` import specifiers to the compiled `.stator.ts` sibling.
  const tsFiles = await walk(outDir, (f) => f.endsWith('.ts'))
  for (const file of tsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  if (css) {
    await mkdir(join(outDir, 'static'), { recursive: true })
    await writeFile(join(outDir, 'static', 'components.css'), css)
  }

  if (islands.length > 0) {
    const manifest = await buildClientAssets(outDir, islands)
    await writeFile(join(outDir, 'stator-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  return { outDir, compiled: statorFiles.length, hasCss: Boolean(css), islands: islands.length }
}

/**
 * Bundle every island entry in one Vite build and derive the manifest.
 * Vite is imported lazily — server-only apps never need it at build time.
 */
async function buildClientAssets(
  outDir: string,
  islands: Array<{ rel: string; entry: string }>,
): Promise<StatorManifest> {
  const [{ build: viteBuild }, { machineStub }] = await Promise.all([
    import('vite'),
    import('../vite/stub.ts'),
  ])

  const input: Record<string, string> = {}
  for (const island of islands) {
    input[island.rel.replace(/\.stator$/, '').replace(/[\\/]/g, '_')] = island.entry
  }

  const assetsDir = join(outDir, 'static', 'assets')
  await viteBuild({
    root: outDir,
    logLevel: 'warn',
    configFile: false,
    plugins: [machineStub({ machinesDir: join(outDir, 'machines') })],
    build: {
      outDir: assetsDir,
      emptyOutDir: true,
      manifest: true,
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

  // Vite's manifest keys inputs by root-relative path; map back to islands.
  const viteManifest = JSON.parse(
    await readFile(join(assetsDir, '.vite', 'manifest.json'), 'utf8'),
  ) as Record<string, { file: string; isEntry?: boolean }>
  const islandUrls: Record<string, string> = {}
  for (const island of islands) {
    const key = relative(outDir, island.entry).replace(/\\/g, '/')
    const entry = viteManifest[key]
    if (!entry) throw new Error(`stator: island "${island.rel}" missing from Vite manifest`)
    islandUrls[island.rel] = `/static/assets/${entry.file}`
  }

  // Per-route reachability: walk each route file's relative-import graph
  // (post-rewrite, so island shells appear as `<island>.ts`) and record which
  // islands it reaches. Mirrors the dev server's module-graph walk.
  const shellToIsland = new Map(islands.map((i) => [resolve(outDir, `${i.rel}.ts`), i.rel]))
  const routeFiles = await walk(join(outDir, 'routes'), (f) => f.endsWith('.ts'))
  const routes: Record<string, string[]> = {}
  for (const routeFile of routeFiles) {
    const reached = new Set<string>()
    await walkImports(routeFile, outDir, new Set(), (file) => {
      const island = shellToIsland.get(file)
      if (island) reached.add(island)
    })
    if (reached.size > 0) {
      routes[relative(outDir, routeFile).replace(/\\/g, '/')] = [...reached]
        .sort()
        .map((rel) => islandUrls[rel]!)
    }
  }

  return { islands: islandUrls, routes }
}

const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** Depth-first walk of a file's relative-import graph, bounded to `outDir`. */
async function walkImports(
  file: string,
  outDir: string,
  seen: Set<string>,
  visit: (file: string) => void,
): Promise<void> {
  if (seen.has(file)) return
  seen.add(file)
  visit(file)
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return
  }
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1]!
    if (!spec.startsWith('.')) continue
    const target = resolve(join(file, '..'), spec)
    if (!target.startsWith(outDir)) continue
    await walkImports(target, outDir, seen, visit)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir: string, match: (file: string) => boolean): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(full)) out.push(full)
  }
  return out
}
