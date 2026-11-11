import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { hashMachines } from '../server/machine-hash.ts'
import { type ArtifactDeps, writeArtifactDeps } from './artifact.ts'
import { compileComponentFile } from './compile-component.ts'
import { type CopySet, resolveCopySet } from './copy-set.ts'
import { bundleIslands, walkFiles } from './islands.ts'
import {
  collisionMessage,
  contractErrors,
  entryTags,
  type IslandReach,
  missingMachines,
  neededMachines,
  reachIslands,
  tagCollisions,
} from './library-islands.ts'
import { routeOfferedEvents } from './offered-events.ts'
import { routeCssMap, routeCssPath } from './route-css.ts'

/**
 * Production build: compile a `.stator` app to a `dist/` of plain `.ts` that
 * `stator start` serves, with no compiler in the process.
 *
 *   1. copy what the app's module graph reaches (see `resolveCopySet`) — the
 *      directories its routes/machines/hooks import from, the root-level files
 *      they open, and `static/`
 *   2. compile each `*.stator` → a sibling `*.stator.ts`, delete the `.stator`,
 *      writing any scoped CSS to a sibling `*.stator.css` (one file per
 *      component, not accumulated — see `route-css.ts`); for client
 *      components also write the generated client entry as a sibling
 *      `*.stator.client.ts`
 *   3. rewrite `.stator` import specifiers (`'./x.stator'` → `'./x.stator.ts'`)
 *   4. walk each route's import graph (`routeCssMap`) and write ONE scoped-CSS
 *      artifact per route under `dist/static/css/`, from exactly the
 *      components that route reaches — local siblings just written, plus any
 *      `node_modules` component library's published sibling stylesheet
 *   5. walk each route's import graph for the islands it reaches, the app's
 *      and any a package ships (`library-islands.ts`), refusing a reached
 *      package component compiled for another contract, two islands defining
 *      one tag, and a package island dispatching to a machine the app does
 *      not register
 *   6. when any island is reached or the app has one: bundle every island
 *      entry through the `bundleIslands` seam (hashed output written under
 *      `dist/static/assets/`, server-machine imports stubbed to `{ name }`)
 *      and write `dist/stator-manifest.json` mapping route files → island
 *      script URLs
 *
 * The prod server runs `createApp` over `dist/` with the `headExtras` hook
 * from `loadProductionHead(dist)` — it links each route's own CSS href from
 * the manifest's `routeCss` and injects the manifest's island
 * `<script type="module">` tags per route. File discovery + dynamic import
 * work unchanged on the precompiled output; the island bundler is needed only
 * at build time, and only when islands exist.
 */

export interface BuildConfig {
  /** App directory containing machines/ routes/ templates/ static/. */
  root: string
  /** Output directory. Wiped and recreated. */
  outDir: string
  /** Override the copied directories entirely. Normally omitted: the copy set
   *  is derived from the app's own module graph — see `resolveCopySet`. */
  dirs?: string[]
  /** Extra app-relative paths to copy verbatim — the escape hatch for what no
   *  import graph can see (a directory reached through a runtime-built path). */
  include?: string[]
  /** What to do about an `import()` no static analysis can follow. `error`
   *  (the default) fails the build naming each one: a copy set that silently
   *  omits a lazily-imported module is a production 500. */
  untracedImports?: 'error' | 'warn'
  /** A `stator-manifest.json` to diff machine hashes against — the last
   *  DEPLOYED build's, fetched by the pipeline — instead of whatever is in
   *  `outDir` from a previous local build (which a fresh CI checkout never
   *  has). Must exist: a path given and not found is an error, not silence. */
  previousManifest?: string
}

export interface BuildResult {
  outDir: string
  /** Number of `.stator` files compiled. */
  compiled: number
  /** True when any route's import graph reached a component with scoped CSS. */
  hasCss: boolean
  /** Number of client components bundled for the browser, the app's and
   *  those its routes reach in packages. */
  islands: number
  /** Machines hashed for the snapshot hydration policy, and how long it took. */
  machines: number
  machineHashMs: number
  /** Machine files (relative to `machines/`) whose code hash differs from the
   *  previous build's manifest — their sessions reset on deploy. `undefined`
   *  when there was no previous manifest to compare against. */
  resetMachines?: string[]
  /** The manifest `resetMachines` was computed against (absolute path), or
   *  `undefined` when there was none — the CLI says so, since silence would
   *  read as "nothing reset". */
  previousManifest?: string
  /** What the module graph said `dist/` needs, and what it left behind. The
   *  CLI prints this — a copy set derived from code should be visible, not
   *  inferred from what shows up in `dist/`. */
  copySet: CopySet
  /** How the artifact declares its dependencies, and how to install them. */
  deps: ArtifactDeps
}

/** Shape of `dist/stator-manifest.json` (always written — carries `buildId`). */
export interface StatorManifest {
  /** Per-build identifier — `stator start` serves it into live pages for the
   *  reload handshake (a client on an older build reloads on reconnect). */
  buildId: string
  /** Island component → its script URL. An app island by its dist-relative
   *  `.stator` path, a package island by package name plus its path inside
   *  the package (`@acme/blocks/src/x.stator`). */
  islands: Record<string, string>
  /** Route file (dist-relative) → script URLs for every island it reaches. */
  routes: Record<string, string[]>
  /** Route file (dist-relative) → its own scoped-CSS stylesheet href, only for
   *  routes whose import graph reaches at least one styled component. Absent
   *  on a dist built before per-route CSS existed, which `loadProductionHead`
   *  reads as "no CSS for any route" (byte-identical to an app with none). */
  routeCss: Record<string, string>
  /** Machine file (relative to `machines/`) → code hash. Consumed by
   *  `stator start` for the snapshot hydration policy; the build fails if a
   *  machine's closure cannot be bundled, so this lands in CI, not at boot. */
  machines: Record<string, string>
  /** Route file (relative to `routes/`) → the event types its page offers
   *  the browser, and any send the build could not read (which leaves the
   *  route open). `stator start` gates `/__events` on it. */
  events: Record<string, { types: string[]; open: string[] }>
  /** The config file copied into the artifact, or `null` when the app has none.
   *  `stator start` reads config from the artifact and nowhere else, so it needs
   *  to tell "this app has no config" from "the config didn't make the trip" —
   *  the second is a partial copy and must fail loudly rather than silently
   *  falling back to in-memory persistence. A manifest without this key is
   *  read as "rebuild". */
  config: string | null
  /** The `@statorjs/stator` version that produced this artifact. */
  statorVersion: string
}

const statorVersion: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version

export async function buildApp(config: BuildConfig): Promise<BuildResult> {
  const root = resolve(config.root)
  const outDir = resolve(config.outDir)

  // What dist needs, from the app's own graph rather than a directory denylist.
  const copySet = await resolveCopySet({ root, include: config.include })
  if (copySet.untraced.length > 0 && (config.untracedImports ?? 'error') === 'error') {
    const where = copySet.untraced.map((u) => `  ${u.file}:${u.line}  ${u.source}`).join('\n')
    throw new Error(
      `stator build: ${copySet.untraced.length} dynamic import${
        copySet.untraced.length === 1 ? '' : 's'
      } cannot be traced, so the build cannot know what to copy:\n${where}\n` +
        `Use a string literal (or a template literal with a fixed prefix, which is expanded), ` +
        `list the directories it reaches in \`build.include\`, or set \`build.untracedImports: 'warn'\` to ship anyway.`,
    )
  }
  const dirs = config.dirs ?? copySet.dirs

  // Remember the previous build's machine hashes (if any) so the build can
  // report which machines' sessions this deploy resets. A manifest given
  // explicitly must be there; the one left in outDir by a previous local build
  // is optional, since a fresh checkout has none.
  const previousPath = config.previousManifest
    ? resolve(config.previousManifest)
    : join(outDir, 'stator-manifest.json')
  const previous = await readFile(previousPath, 'utf8')
    .then((t) => (JSON.parse(t) as Partial<StatorManifest>).machines)
    .catch((err: unknown) => {
      if (config.previousManifest) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`cannot read the previous manifest ${previousPath} — ${msg}`)
      }
      return undefined
    })

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const d of dirs) {
    const src = join(root, d)
    if (await exists(src)) await cp(src, join(outDir, d), { recursive: true })
  }

  // Root-level files the graph reached: the single-file hooks (middleware.ts,
  // boot.ts, stator.config.*) and any data file a module opens by path, such
  // as an `import.meta.url`-relative SQLite file.
  for (const file of copySet.files) {
    const src = join(root, file)
    if (!(await exists(src))) continue
    const dest = join(outDir, file)
    // `build.include` may name a nested file, and cp() will not create its
    // parent for us.
    if (file.includes('/')) await mkdir(dirname(dest), { recursive: true })
    await cp(src, dest)
  }

  // Compile every .stator into a sibling .stator.ts (+ a sibling .stator.css
  // when it has scoped styles — the same per-component shape a library's own
  // publish-time compile produces, see route-css.ts) and islands. The sources
  // are deleted only after the whole set compiles — cross-file region
  // validation reads sibling `.stator` files mid-compile.
  const statorFiles = await walkFiles(outDir, (f) => f.endsWith('.stator'))
  const islands: Array<{ rel: string; entry: string }> = []
  for (const file of statorFiles) {
    const { rel, isClient, clientFile } = await compileComponentFile(file, outDir, {
      sourcePath: join(root, relative(outDir, file)),
    })
    if (isClient) islands.push({ rel, entry: clientFile! })
  }
  for (const file of statorFiles) await rm(file)

  // Rewrite `.stator` import specifiers to the compiled `.stator.ts` sibling:
  // relative ones and `#` subpath imports, which land in the app. A package's
  // `@acme/blocks/x.stator` is its own `exports` key and stays as written.
  const tsFiles = await walkFiles(outDir, (f) => f.endsWith('.ts'))
  for (const file of tsFiles) {
    const code = await readFile(file, 'utf8')
    const rewritten = code.replace(/(['"])((?:\.{1,2}\/|#)[^'"]*\.stator)\1/g, '$1$2.ts$1')
    if (rewritten !== code) await writeFile(file, rewritten)
  }

  // Route-level, usage-driven CSS: one artifact per route, from exactly the
  // components that route's own import graph reaches (local siblings just
  // written above, plus any node_modules component library's published
  // sibling stylesheet) — not every component anywhere in the app.
  const routeCss = await routeCssMap({ routesDir: join(outDir, 'routes'), baseDir: outDir })
  const routeCssHrefs: Record<string, string> = {}
  for (const [routeFile, text] of routeCss) {
    const cssPath = routeCssPath(relative(outDir, routeFile))
    const dest = join(outDir, 'static', cssPath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text)
    routeCssHrefs[relative(outDir, routeFile).replace(/\\/g, '/')] = `/static/${cssPath}`
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

  // Islands: the app's own, plus every one a route reaches in a package, and
  // the checks that make shipping a package's compiled output safe.
  const shells = new Map(islands.map((i) => [resolve(outDir, `${i.rel}.ts`), i.rel]))
  const reach = await reachIslands({ routesDir: join(outDir, 'routes'), baseDir: outDir, shells })
  await checkReach(reach, islands, machinesDir)
  const allIslands = [
    ...islands,
    ...[...reach.packageIslands.values()].map((i) => ({ rel: i.rel, entry: i.entry })),
  ]

  // The dependency half of the artifact: the app's own manifest + lockfile when
  // it has one, else a pinned manifest. Written after the tree so a generated
  // package.json cannot be clobbered by the copy step.
  const deps = await writeArtifactDeps({ root, outDir, packages: copySet.packages })

  // Always write the manifest — it carries the build-id even for an app with no
  // islands (a live route without islands still needs the reload handshake).
  // The config file the artifact carries, by name — `copySet.files` holds it if
  // the app has one, since the graph walk treats it as an entry point.
  const configFile = copySet.files.find((f) => /^stator\.config\.(ts|mts|js|mjs)$/.test(f)) ?? null
  const events: StatorManifest['events'] = {}
  const builtRoutes = join(outDir, 'routes')
  for (const routeFile of await walkFiles(builtRoutes, (f) => /\.(ts|js)$/.test(f))) {
    const offered = await routeOfferedEvents(routeFile, outDir)
    events[relative(builtRoutes, routeFile).replace(/\\/g, '/')] = {
      types: [...offered.types].sort(),
      open: [...offered.open],
    }
  }
  const manifest: StatorManifest =
    allIslands.length > 0
      ? {
          buildId: randomUUID(),
          ...(await buildClientAssets(outDir, allIslands, reach)),
          routeCss: routeCssHrefs,
          machines,
          events,
          config: configFile,
          statorVersion,
        }
      : {
          buildId: randomUUID(),
          islands: {},
          routes: {},
          routeCss: routeCssHrefs,
          machines,
          events,
          config: configFile,
          statorVersion,
        }
  await writeFile(join(outDir, 'stator-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    outDir,
    compiled: statorFiles.length,
    hasCss: Object.keys(routeCssHrefs).length > 0,
    islands: allIslands.length,
    machines: machineFiles.length,
    machineHashMs,
    ...(resetMachines ? { resetMachines, previousManifest: previousPath } : {}),
    copySet,
    deps,
  }
}

/**
 * Bundle every island entry through the seam, write the emitted files under
 * `static/assets/`, and derive the route → island-script manifest.
 */
async function buildClientAssets(
  outDir: string,
  islands: Array<{ rel: string; entry: string }>,
  reach: IslandReach,
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

  const routes: Record<string, string[]> = {}
  for (const [routeFile, rels] of reach.routes) {
    routes[relative(outDir, routeFile).replace(/\\/g, '/')] = rels.map(
      (rel) => bundle.islandUrls[rel]!,
    )
  }
  return { islands: bundle.islandUrls, routes }
}

/**
 * Refuse what the walk found unsafe to ship: a reached package component whose
 * contract stamp this compiler does not read, two islands defining one custom
 * element tag, a package island dispatching to a machine the app does not
 * register. Every problem is listed at once.
 */
async function checkReach(
  reach: IslandReach,
  appIslands: Array<{ rel: string; entry: string }>,
  machinesDir: string,
): Promise<void> {
  const errors = await contractErrors(reach.packageComponents.values())
  const tagged = []
  for (const i of appIslands) {
    for (const tag of entryTags(await readFile(i.entry, 'utf8'))) {
      tagged.push({ rel: i.rel, tag, source: i.rel })
    }
  }
  for (const i of [...reach.packageIslands.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    for (const tag of entryTags(await readFile(i.entry, 'utf8'))) {
      tagged.push({ rel: i.rel, tag, source: i.rel })
    }
  }
  errors.push(...tagCollisions(tagged).map(collisionMessage))
  // The app's machines are imported only when a package island dispatches.
  if ((await neededMachines(reach.packageIslands.values())).size > 0) {
    const { discoverMachines } = await import('../server/discovery.ts')
    const { defs } = await discoverMachines(machinesDir)
    errors.push(
      ...(await missingMachines(reach.packageIslands.values(), new Set(defs.map((d) => d.name)))),
    )
  }
  if (errors.length > 0) {
    const n = errors.length
    throw new Error(
      `stator build: ${n} problem${n === 1 ? '' : 's'} with what the routes reach:\n` +
        errors.map((e) => `  ${e}`).join('\n'),
    )
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
