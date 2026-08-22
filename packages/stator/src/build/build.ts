import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { compile, regionResolverFor } from '../compiler/index.ts'
import { hashMachines } from '../server/machine-hash.ts'
import { bundleIslands, routeIslandMap, walkFiles } from './islands.ts'
import { sourceId } from './source-id.ts'

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
 *   5. when the app has client components: bundle every island entry through
 *      the `bundleIslands` seam (hashed output written under
 *      `dist/static/assets/`, server-machine imports stubbed to `{ name }`),
 *      walk each route's import graph to find which islands it reaches, and
 *      write `dist/stator-manifest.json` mapping route files → island script URLs
 *
 * The prod server runs `createApp` over `dist/` with the `headExtras` hook
 * from `loadProductionHead(dist)` — it links `components.css` and injects the
 * manifest's `<script type="module">` tags per route. File discovery + dynamic
 * import work unchanged on the precompiled output; the island bundler is
 * needed only at build time, and only when islands exist.
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
  /** Machines hashed for the snapshot hydration policy, and how long it took. */
  machines: number
  machineHashMs: number
  /** Machine files (relative to `machines/`) whose code hash differs from the
   *  previous build's manifest — their sessions reset on deploy. `undefined`
   *  when there was no previous manifest to compare against. */
  resetMachines?: string[]
}

/** Shape of `dist/stator-manifest.json` (always written — carries `buildId`). */
export interface StatorManifest {
  /** Per-build identifier — `stator start` serves it into live pages for the
   *  reload handshake (a client on an older build reloads on reconnect). */
  buildId: string
  /** Island component (dist-relative `.stator` path) → its script URL. */
  islands: Record<string, string>
  /** Route file (dist-relative) → script URLs for every island it reaches. */
  routes: Record<string, string[]>
  /** Machine file (relative to `machines/`) → code hash. Consumed by
   *  `stator start` for the snapshot hydration policy; the build fails if a
   *  machine's closure cannot be bundled, so this lands in CI, not at boot. */
  machines: Record<string, string>
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

  // Remember the previous build's machine hashes (if any) so the build can
  // report which machines' sessions this deploy resets.
  const previous = await readFile(join(outDir, 'stator-manifest.json'), 'utf8')
    .then((t) => (JSON.parse(t) as Partial<StatorManifest>).machines)
    .catch(() => undefined)

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const d of dirs) {
    const src = join(root, d)
    if (await exists(src)) await cp(src, join(outDir, d), { recursive: true })
  }

  // A root-level middleware.ts is a single file, not a source dir — copy it too
  // (raw TS, run under tsx/native in prod like the rest of the server).
  const middlewareSrc = join(root, 'middleware.ts')
  if (await exists(middlewareSrc)) await cp(middlewareSrc, join(outDir, 'middleware.ts'))
  // Same for a root-level boot.ts (the once-at-startup hook).
  const bootSrc = join(root, 'boot.ts')
  if (await exists(bootSrc)) await cp(bootSrc, join(outDir, 'boot.ts'))

  // Compile every .stator into a sibling .stator.ts; collect CSS and islands.
  // The sources are deleted only after the whole set compiles — cross-file
  // region validation reads sibling `.stator` files mid-compile.
  const statorFiles = await walkFiles(outDir, (f) => f.endsWith('.stator'))
  let css = ''
  const islands: Array<{ rel: string; entry: string }> = []
  for (const file of statorFiles) {
    const source = await readFile(file, 'utf8')
    const { id: rel, kind } = sourceId(outDir, file)
    const result = compile(source, {
      id: rel,
      kind,
      resolveRegions: regionResolverFor(file, source),
    })
    await writeFile(`${file}.ts`, result.serverCode)
    if (result.isClient) {
      // The generated client entry, written as a sibling so the authored
      // script's relative imports resolve against the mirrored dist tree.
      await writeFile(`${file}.client.ts`, result.clientCode)
      islands.push({ rel, entry: `${file}.client.ts` })
    }
    if (result.css) css += `/* ${rel} */\n${result.css}\n`
  }
  for (const file of statorFiles) await rm(file)

  // Rewrite `.stator` import specifiers to the compiled `.stator.ts` sibling.
  const tsFiles = await walkFiles(outDir, (f) => f.endsWith('.ts'))
  for (const file of tsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  if (css) {
    await mkdir(join(outDir, 'static'), { recursive: true })
    await writeFile(join(outDir, 'static', 'components.css'), css)
  }

  // Machine code hashes for the snapshot hydration policy: one esbuild pass
  // over dist/machines. Throws (failing the build) if a closure can't bundle.
  const machinesDir = join(outDir, 'machines')
  const machineFiles = (
    await walkFiles(machinesDir, (f) => /\.(ts|js)$/.test(f)).catch(() => [] as string[])
  ).filter((f) => resolve(f, '..') === resolve(machinesDir))
  const t0 = performance.now()
  const hashed = await hashMachines(machineFiles, { machinesDir })
  const machineHashMs = Math.round(performance.now() - t0)
  const machines: Record<string, string> = {}
  for (const file of machineFiles.sort()) {
    machines[relative(machinesDir, file).replace(/\\/g, '/')] = hashed.get(file)!.hash
  }
  const resetMachines = previous
    ? Object.keys(machines).filter((k) => previous[k] !== machines[k])
    : undefined

  // Always write the manifest — it carries the build-id even for an app with no
  // islands (a live route without islands still needs the reload handshake).
  const manifest: StatorManifest =
    islands.length > 0
      ? { buildId: randomUUID(), ...(await buildClientAssets(outDir, islands)), machines }
      : { buildId: randomUUID(), islands: {}, routes: {}, machines }
  await writeFile(join(outDir, 'stator-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    outDir,
    compiled: statorFiles.length,
    hasCss: Boolean(css),
    islands: islands.length,
    machines: machineFiles.length,
    machineHashMs,
    ...(resetMachines ? { resetMachines } : {}),
  }
}

/**
 * Bundle every island entry through the seam, write the emitted files under
 * `static/assets/`, and derive the route → island-script manifest.
 */
async function buildClientAssets(
  outDir: string,
  islands: Array<{ rel: string; entry: string }>,
): Promise<Pick<StatorManifest, 'islands' | 'routes'>> {
  const bundle = await bundleIslands({
    root: outDir,
    machinesDir: join(outDir, 'machines'),
    entries: islands.map((i) => ({ rel: i.rel, file: i.entry })),
  })

  const assetsDir = join(outDir, 'static', 'assets')
  await rm(assetsDir, { recursive: true, force: true })
  for (const asset of bundle.assets) {
    const target = join(assetsDir, asset.fileName)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, asset.source)
  }

  // Per-route reachability over the rewritten dist tree: island shells appear
  // as `<island>.stator.ts`.
  const shells = new Map(islands.map((i) => [resolve(outDir, `${i.rel}.ts`), i.rel]))
  const byRoute = await routeIslandMap({
    routesDir: join(outDir, 'routes'),
    baseDir: outDir,
    shells,
  })
  const routes: Record<string, string[]> = {}
  for (const [routeFile, rels] of byRoute) {
    routes[relative(outDir, routeFile).replace(/\\/g, '/')] = rels.map(
      (rel) => bundle.islandUrls[rel]!,
    )
  }
  return { islands: bundle.islandUrls, routes }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
