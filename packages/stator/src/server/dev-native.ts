import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import chokidar from 'chokidar'
import type { Hono } from 'hono'
import { bundleIslands, type IslandBundle, localImports, walkFiles } from '../build/islands.ts'
import {
  collisionMessage,
  entryTags,
  missingMachines,
  type PackageIsland,
  reachIslands,
  type TaggedIsland,
  tagCollisions,
} from '../build/library-islands.ts'
import { routeCssMap, routeCssPath } from '../build/route-css.ts'
import { sourceId } from '../build/source-id.ts'
import { CompileError, compile, formatCompileError, regionResolverFor } from '../compiler/index.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { findFreePort, installGracefulShutdown, printDevBanner } from './banner.ts'
import { type BootTeardown, discoverBoot, runBoot } from './boot.ts'
import type { DevAppConfig } from './dev.ts'
import { findPollLoops } from './dev-lint.ts'
import { registerDevLoader } from './dev-loader.ts'
import { isPrunedDevPath } from './dev-watch.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { loadDotenv } from './env.ts'
import { buildHonoApp, contentTypeFor } from './http.ts'
import { resolveImagesConfig } from './images.ts'
import { logger, setLogLevel } from './logger.ts'
import { codeHashOf, codeInputsOf } from './machine-hash.ts'
import { MachineStore } from './machine-store.ts'
import { discoverMiddleware } from './middleware.ts'
import { resolveAppConfig } from './resolve-config.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { discoverRoutes } from './route-discovery.ts'
import { isStatorQueryRoute } from './routing.ts'
import { drainAndClose } from './shutdown.ts'
import { broadcastEnvelope } from './sse.ts'
import { InMemoryStore } from './store.ts'

/**
 * Native dev server. The server runs from the app's SOURCE tree with no
 * mirror: `.stator` files are compiled on
 * import by `dev-loader.ts` (the framework compiler + esbuild on Node's loader
 * hooks), machines/routes/middleware are discovered from their real paths, and
 * the app is served by Hono exactly as `stator start` serves a build. Because
 * nothing is copied, `import.meta.url`-relative paths in app code (a SQLite
 * file, a data dir) mean the same thing in dev as in prod.
 *
 * The dev-only capabilities:
 *  - **Live reload** — a source change bumps the version of the changed file
 *    and its transitive importers (a static reverse import graph; the loader
 *    stamps every app module with its own `?v=`), so exactly that subtree
 *    re-evaluates and everything else keeps its module instance; connected
 *    browsers reload via a tiny SSE channel (`/__stator_dev`). A failed rebuild keeps the last good
 *    graph serving and renders the error (with its code frame) in an overlay.
 *  - **Scoped CSS + island scripts** — islands bundle through the
 *    `bundleIslands` seam (esbuild, never on the SSR path) and are served
 *    from memory with each route's scoped CSS, local and `node_modules`
 *    alike, on the same URLs and with the same `<head>` shape as production.
 */
export interface NativeDevApp {
  fetch: (request: Request) => Response | Promise<Response>
  readonly hono: Hono
  dispatchToApp<D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ): Promise<{ committed: boolean }>
  listen: (port: number) => Promise<{ port: number }>
  close: () => Promise<void>
}

// The dev browser client: reloads on a successful
// rebuild and renders a full-screen overlay with the message on a build failure, so
// a compile error is visible instead of a frozen page.
//
// Transport depends on the page. A `live: true` page already holds a /__sse stream,
// so the dev signals ride it and this script opens NOTHING — a second event-stream
// would take a second slot from the browser's six-per-origin pool (shared across
// every tab in the profile), and two-per-tab is what wedges a dev session at three
// tabs. Reload arrives there as the wire protocol's own directive, applied by the
// page runtime; only the dev-only error overlay needs listening for. Pages without
// a live channel keep their own /__stator_dev stream — still one per tab.
const DEV_OVERLAY = `let o;const show=(m)=>{if(o)o.remove();o=document.createElement('div');o.style.cssText='position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:#1a1015;color:#f8d7da;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap';o.textContent='stator \\u2014 build failed\\n\\n'+m;document.body.appendChild(o)};const go=(m)=>{if(m.type==='reload')location.reload();else if(m.type==='error')show(m.message)};`

/** A page route (not a data route) declared `live: true` — the pages that hold
 *  a /__sse stream, and so need no second one for dev signals. */
const isLiveRoute = (def: DiscoveredRoute['GET']): boolean =>
  def !== undefined && !isStatorQueryRoute(def) && def.live === true

/** `live` pages piggyback on /__sse; everything else opens /__stator_dev. */
const devClientScript = (live: boolean): string =>
  live
    ? `(()=>{${DEV_OVERLAY}window.addEventListener('stator:live-message',(e)=>{const d=e.detail&&e.detail.envelope&&e.detail.envelope.dev;if(d)go(d)})})()`
    : `(()=>{${DEV_OVERLAY}const es=new EventSource('/__stator_dev');es.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return}go(m)}})()`

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__'])
const APP_EXT = /\.(stator|ts|tsx|mts|cts|js|mjs)$/
const EMPTY_BUNDLE: IslandBundle = { islandUrls: {}, assets: [], modules: [] }
const norm = (p: string): string => p.replace(/\\/g, '/')

export async function createNativeDevApp(config: DevAppConfig): Promise<NativeDevApp> {
  // Real paths throughout: Node's resolver realpaths module URLs, and the
  // per-file version map must key on what the loader sees.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const root = real(resolve(config.root))
  loadDotenv(root)

  const resolved = resolveAppConfig(config)
  // One session store for the life of the dev process. Rebuilds swap the
  // MachineStore AROUND it, so sessions survive an edit unless their machine's
  // code hash changed (hydration policy). Creating the default store inside
  // rebuildStore would silently reset every session on any machine-touching
  // edit — the opposite of what the per-machine hash promises.
  const sessionStore = resolved.session ?? new InMemoryStore()
  const logLevel = process.env.LOG_LEVEL ?? resolved.logLevel ?? 'info'
  setLogLevel(logLevel)
  const inspectorOn = resolved.inspector ?? true
  const machinesDir = real(resolve(config.machinesDir))
  const routesDir = real(resolve(config.routesDir))
  const staticDir = config.staticDir ? real(resolve(config.staticDir)) : resolve(root, 'static')
  const images = config.images ? resolveImagesConfig(config.images) : undefined
  // One build-id per successful BUILD, not per process. Connected pages reload
  // through the dev signal, but a page whose channel was released while it sat
  // in the background (or dropped over a blip) never sees that signal — it
  // reconnects later carrying the id it was rendered against, and the /__sse
  // handshake is the only thing that can tell it its slot-ID map is stale. A
  // per-process id would answer "same build" to a page from three rebuilds ago.
  let buildId = randomUUID()

  // ── Module graph + per-file versions (importer-only invalidation) ──────────
  // An edit re-evaluates the changed file and its transitive importers — nothing
  // else. The graph is a static regex read of relative imports (no evaluation),
  // rebuilt on structural changes and patched per edited file otherwise; the
  // loader stamps each app module with its version at resolve time.
  const versions = new Map<string, number>()
  // The dev loader, before the first app import: `.stator` compile-on-load plus
  // `?v=` stamping from `versions`, scoped to the app root.
  const loader = registerDevLoader({ appDir: root, versions })
  const forward = new Map<string, Set<string>>()
  const importers = new Map<string, Set<string>>()
  const bumpVersions = (files: Iterable<string>): void => {
    for (const f of files) versions.set(f, (versions.get(f) ?? 1) + 1)
  }
  const bust = (file: string): Promise<Record<string, unknown>> =>
    import(`${pathToFileURL(file).href}?v=${versions.get(file) ?? 1}`)

  // ── Dev live-reload channel ──────────────────────────────────────────────────
  // Only pages WITHOUT a live channel open this. A `live: true` page already
  // holds a /__sse stream, and its dev signals ride that one instead — a
  // second event-stream would spend another slot from the browser's six-per-
  // origin pool (shared across every tab in the profile), which is what wedges
  // a multi-tab dev session at three tabs.
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  type DevMessage = { type: 'reload' } | { type: 'error'; message: string }
  const broadcast = (msg: DevMessage): void => {
    const frame = enc.encode(`data: ${JSON.stringify(msg)}\n\n`)
    for (const c of reloadClients) {
      try {
        c.enqueue(frame)
      } catch {
        reloadClients.delete(c)
      }
    }
    // Live pages: a reload rides the wire protocol's own directive (the page
    // runtime applies it with no dev-specific code), an error rides a `dev`
    // key the production runtime ignores and the dev client picks up off
    // `stator:live-message`.
    void broadcastEnvelope(
      msg.type === 'reload' ? { directives: [{ type: 'reload' }] } : { dev: msg },
    )
  }
  const devReloadResponse = (): Response => {
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller
          controller.enqueue(enc.encode(': connected\n\n'))
          reloadClients.add(controller)
        },
        // Disconnect arrives as a stream cancel; without this the controller
        // lingers until the next broadcast's enqueue throws, and this channel
        // has no heartbeat to provoke one.
        cancel() {
          if (mine) reloadClients.delete(mine)
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      },
    )
  }

  // ── Source scan: scoped CSS + island-ness of every `.stator` ───────────────
  // The loader compiles each `.stator` into its server module on import; this
  // main-thread pass compiles for the two things the <head> needs up front —
  // scoped CSS and which files are islands. Same `sourceId`, so the scope
  // hashes agree with the markup the loader emits.
  interface StatorInfo {
    css: string
    isClient: boolean
    /** The custom-element tag an island defines. */
    tag?: string
  }
  const infos = new Map<string, StatorInfo>() // abs `.stator` → info
  const skipDir = (name: string): boolean => name.startsWith('.') || SKIP_DIRS.has(name)
  // Prune rules apply to the path RELATIVE to the app root — the root's own
  // ancestors may legitimately contain a `tests/` or a dot-dir.
  const relOf = (abs: string): string => norm(relative(root, abs))
  const pruned = (rel: string): boolean => rel.startsWith('..') || isPrunedDevPath(rel)
  const isAppFile = (abs: string): boolean => APP_EXT.test(abs) && !pruned(relOf(abs))

  const setEdges = (file: string, children: Set<string>): void => {
    for (const old of forward.get(file) ?? []) importers.get(old)?.delete(file)
    forward.set(file, children)
    for (const child of children) {
      const set = importers.get(child) ?? new Set<string>()
      set.add(file)
      importers.set(child, set)
    }
  }
  const updateEdges = async (files: string[]): Promise<void> => {
    for (const f of files) {
      setEdges(f, new Set((await localImports(f, root)).filter(isAppFile)))
    }
  }
  const buildGraph = async (): Promise<void> => {
    forward.clear()
    importers.clear()
    await updateEdges(await walkFiles(root, (f) => APP_EXT.test(f), skipDir))
  }
  /** The changed files plus everything that (transitively) imports them. */
  const affectedBy = (files: string[]): Set<string> => {
    const out = new Set<string>()
    const stack = [...files]
    while (stack.length) {
      const f = stack.pop()!
      if (out.has(f)) continue
      out.add(f)
      for (const parent of importers.get(f) ?? []) stack.push(parent)
    }
    return out
  }
  const compileInfo = async (file: string): Promise<StatorInfo> => {
    const source = await readFile(file, 'utf8')
    const { id, kind } = sourceId(root, file)
    const r = compile(source, { id, kind, resolveRegions: regionResolverFor(file, source) })
    return { css: r.css ?? '', isClient: r.isClient, tag: r.clientTag }
  }
  // Tolerant at boot: a broken file is logged and skipped here (it surfaces
  // with its code frame when something imports it), so one bad template
  // doesn't keep the whole dev server from starting.
  const scanAll = async (): Promise<void> => {
    infos.clear()
    for (const file of await walkFiles(root, (f) => f.endsWith('.stator'), skipDir)) {
      try {
        infos.set(file, await compileInfo(file))
      } catch (err) {
        logger.error({ file: sourceId(root, file).id, err: describe(err) }, 'compile failed')
        infos.set(file, { css: '', isClient: false })
      }
    }
  }
  // Per-route scoped CSS, exactly as `stator build` writes it: the same walk
  // over each route's import graph (`routeCssMap`), the same URL, only the CSS
  // of components that route can reach. The CSS itself comes from the
  // in-memory compile rather than sibling files on disk.
  let routeSheets = new Map<string, string>() // abs route file → stylesheet URL
  let sheetBodies = new Map<string, string>() // stylesheet URL → CSS
  const regenCss = async (): Promise<void> => {
    const byRoute = await routeCssMap({
      routesDir,
      baseDir: root,
      cssFor: (file) => infos.get(file)?.css || undefined,
    })
    const sheets = new Map<string, string>()
    const bodies = new Map<string, string>()
    for (const [file, text] of byRoute) {
      const href = `/static/${routeCssPath(relative(root, file))}`
      sheets.set(resolve(file), href)
      bodies.set(href, text)
    }
    routeSheets = sheets
    sheetBodies = bodies
  }

  // ── Islands: bundled through the seam, held in memory ──────────────────────
  let islands: IslandBundle = EMPTY_BUNDLE
  const assetBodies = new Map<string, string | Uint8Array>() // URL path → body
  let islandGraph = new Set<string>() // every source module in the last bundle
  let routeIslands = new Map<string, string[]>() // abs route file → island rels
  // Islands the routes reach inside packages, found by the same walk as the
  // route mapping; a change to the set (an edit adding an import) rebundles.
  let packageIslands = new Map<string, PackageIsland>()
  // Rels not served because an earlier island holds their tag (logged once).
  let shadowed = new Set<string>()
  const loggedProblems = new Set<string>()
  const islandFiles = (): string[] => [...infos].filter(([, i]) => i.isClient).map(([f]) => f)
  const rebundleIslands = async (): Promise<void> => {
    const entries = [
      ...islandFiles().map((file) => ({ rel: sourceId(root, file).id, file })),
      ...[...packageIslands.values()].map((i) => ({ rel: i.rel, file: i.entry })),
    ]
    // Inline sourcemaps in dev: browser devtools show island SOURCE, and the
    // in-memory bundle stays self-contained (no `.map` files to serve).
    islands = entries.length
      ? await bundleIslands({ root, machinesDir, entries, sourcemap: true })
      : EMPTY_BUNDLE
    assetBodies.clear()
    for (const a of islands.assets) assetBodies.set(`/static/assets/${a.fileName}`, a.source)
    islandGraph = new Set(islands.modules)
  }
  /** Re-walk the routes; true when the package island set moved. */
  const remapRoutes = async (): Promise<boolean> => {
    const shells = new Map(islandFiles().map((file) => [file, sourceId(root, file).id]))
    const reach = await reachIslands({ routesDir, baseDir: root, shells })
    routeIslands = reach.routes
    const before = [...packageIslands.keys()].sort().join('\n')
    packageIslands = reach.packageIslands
    return [...packageIslands.keys()].sort().join('\n') !== before
  }
  // What `stator build` refuses, logged here instead: dev keeps serving the
  // island that holds a tag first (app islands, then packages by rel), names
  // the route reaching the other, and the next build fails on it.
  const checkIslands = async (): Promise<void> => {
    const tagged: TaggedIsland[] = []
    for (const file of islandFiles()) {
      const tag = infos.get(file)?.tag
      if (tag) tagged.push({ rel: sourceId(root, file).id, tag, source: sourceId(root, file).id })
    }
    for (const i of [...packageIslands.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      for (const tag of entryTags(await readFile(i.entry, 'utf8'))) {
        tagged.push({ rel: i.rel, tag, source: i.rel })
      }
    }
    const collisions = tagCollisions(tagged)
    shadowed = new Set(collisions.map((c) => c.other.rel))
    const problems = collisions.map((c) => {
      const route = [...routeIslands].find(([, rels]) => rels.includes(c.other.rel))?.[0]
      const reached = route ? ` (${sourceId(root, route).id} reaches ${c.other.source})` : ''
      return `${collisionMessage(c)}${reached} Serving ${c.holder.source} in dev.`
    })
    problems.push(
      ...(await missingMachines(packageIslands.values(), new Set(defs.map((d) => d.name)))),
    )
    for (const msg of problems) {
      if (loggedProblems.has(msg)) continue
      loggedProblems.add(msg)
      logger.error(msg)
    }
  }

  // Production head shape (CSS link + per-route island scripts), then the dev
  // inspector and the reload client layered on top.
  const headExtras = (routeFile: string): string => {
    const head: string[] = []
    const sheet = routeSheets.get(resolve(routeFile))
    if (sheet) head.push(`<link rel="stylesheet" href="${sheet}">`)
    for (const rel of routeIslands.get(resolve(routeFile)) ?? []) {
      if (shadowed.has(rel)) continue
      const url = islands.islandUrls[rel]
      if (url) head.push(`<script type="module" src="${url}"></script>`)
    }
    if (inspectorOn) head.push('<script src="/@stator/inspector.js" defer></script>')
    // Liveness is decided HERE, not sniffed from the DOM: headExtras is injected
    // ahead of the `stator-live` meta, so a script querying for it would always
    // find nothing and open a redundant stream.
    const abs = resolve(routeFile)
    const live = routes.some((r) => resolve(r.filePath) === abs && isLiveRoute(r.GET))
    head.push(`<script>${devClientScript(live)}</script>`)
    return head.join('\n')
  }

  // Dev-owned URLs answered ahead of the app: the reload channel and the
  // in-memory build outputs. Everything else — including the app's real
  // `static/` dir, served in place — falls through to Hono.
  const noCache = (type: string): HeadersInit => ({
    'Content-Type': type,
    'Cache-Control': 'no-cache',
  })
  const serveDev = (request: Request): Response | undefined => {
    const { pathname } = new URL(request.url)
    if (pathname === '/__stator_dev') return devReloadResponse()
    const sheet = sheetBodies.get(pathname)
    if (sheet !== undefined)
      return new Response(sheet, { headers: noCache('text/css; charset=utf-8') })
    const body = assetBodies.get(pathname)
    if (body !== undefined)
      return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
        headers: noCache(contentTypeFor(pathname)),
      })
    return undefined
  }

  // ── App graph (rebuilt on edits) ────────────────────────────────────────────
  let store: MachineStore
  let defs: AnyMachineDef[] = []
  let routes: Awaited<ReturnType<typeof discoverRoutes>> = []
  let machineCount = 0
  let app: Hono
  const handle = (request: Request): Response | Promise<Response> =>
    serveDev(request) ?? app.fetch(request)

  // Which machines' code hashes changed across a store rebuild — the sessions
  // of exactly those start fresh on their next request (hydration policy).
  const rebuildStore = async (): Promise<string[]> => {
    const before = new Map(defs.map((d) => [d.name, codeHashOf(d)]))
    defs = (await discoverMachines(machinesDir, bust)).defs
    machineCount = defs.length
    const changed = defs.filter((d) => before.has(d.name) && before.get(d.name) !== codeHashOf(d))
    store = new MachineStore(defs, sessionStore, {
      sessionTtlSeconds: resolved.sessionTtlSeconds,
      appStore: resolved.app,
    })
    wireAppEffects(store)
    await store.bootAppMachines()
    // Dev-only lint: a session machine whose `after` timer drives a loop with
    // a data-loading entry effect is server-side polling that runs for
    // sessions nobody is watching. Warn with the steer, don't block.
    for (const f of findPollLoops(defs)) {
      console.warn(
        `stator: session machine "${f.machine}" self-reschedules through \`after\` ` +
          `(${f.cycle.join(' → ')} via ${f.event}) with a data-loading entry effect on the loop. ` +
          `This polls upstream for sessions nobody is watching. Prefer a client-owned clock ` +
          `with a staleness guard — see the effects guide, "Who owns the clock".`,
      )
    }
    return changed.map((d) => d.name)
  }

  // An edit touches a machine when the file is in that machine's hashed
  // closure — the machine file itself or anything it imports. (A file under
  // machines/ that no machine reaches is still a structural change to the set.)
  const touchesMachine = (files: string[]): boolean =>
    files.some(
      (f) => f.startsWith(machinesDir + sep) || defs.some((d) => codeInputsOf(d).includes(f)),
    )

  const rebuildServer = async (): Promise<void> => {
    routes = await discoverRoutes(routesDir, bust)
    const middleware = await discoverMiddleware(resolve(root, 'middleware.ts'), bust)
    app = await buildHonoApp({
      images,
      routes,
      store,
      staticDir,
      headExtras,
      inspector: inspectorOn,
      inspect: true,
      trustedOrigins: resolved.trustedOrigins,
      sameSite: resolved.sameSite,
      origin: resolved.origin,
      secret: resolved.secret,
      buildId,
      cors: resolved.cors,
      middleware,
    })
  }

  await scanAll()
  await buildGraph()
  await regenCss()
  await remapRoutes()
  await rebundleIslands()
  await rebuildStore()
  await checkIslands()
  await rebuildServer()

  // boot.ts once per process (a long-lived source shouldn't restart on edits).
  const bootDef = await discoverBoot(resolve(root, 'boot.ts'), bust)

  // ── Watch → recompile → reload ──────────────────────────────────────────────
  // Recompile just what changed, then bump the changed files + their importers
  // so exactly that subtree re-evaluates. Islands rebundle only when an edit
  // touches a module the last bundle contained (the seam reports that set), a
  // file became an island, or the file set changed; machine edits rebuild the
  // store; everything rebuilds the server graph.
  const doRebuild = async (files: string[], structural: boolean): Promise<void> => {
    const t0 = performance.now()
    let rebundled = false
    let storeRebuilt = false
    let machinesChanged: string[] = []
    try {
      if (structural) {
        await scanAll()
        await buildGraph()
      } else {
        for (const f of files) if (f.endsWith('.stator')) infos.set(f, await compileInfo(f))
        await updateEdges(files)
      }
      const affected = affectedBy(files)
      bumpVersions(affected)
      await regenCss()
      const packagesMoved = await remapRoutes()
      const needsBundle =
        structural ||
        packagesMoved ||
        files.some((f) => islandGraph.has(norm(f)) || infos.get(f)?.isClient)
      if (needsBundle) {
        await rebundleIslands()
        rebundled = true
      }
      if (touchesMachine(files)) {
        machinesChanged = await rebuildStore()
        storeRebuilt = true
      }
      await checkIslands()
      buildId = randomUUID()
      await rebuildServer()
      broadcast({ type: 'reload' })
      logger.info(
        {
          ms: Math.round(performance.now() - t0),
          modules: affected.size,
          islands: rebundled,
          store: storeRebuilt,
          routes: routes.length,
          files: files.map((f) => sourceId(root, f).id),
        },
        'reloaded',
      )
      if (storeRebuilt) {
        logger.info(
          { machines: machinesChanged },
          machinesChanged.length
            ? 'machine code changed — their sessions start fresh on the next request'
            : 'machine files changed but no machine code changed — sessions carry over',
        )
      }
    } catch (err) {
      // Keep serving the last good graph, but surface the failure (with its code
      // frame for a compile error) in the browser instead of a frozen page.
      const message = describe(err)
      logger.error(
        { err: message, structural, files: files.map((f) => sourceId(root, f).id) },
        'reload failed',
      )
      broadcast({ type: 'error', message })
    }
  }

  const changed = new Set<string>()
  let structural = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reloadChain: Promise<void> = Promise.resolve()
  // chokidar gives reliable add/change/unlink events across macOS/Linux/Windows,
  // and awaitWriteFinish coalesces an editor's atomic save (temp write + rename)
  // into one settled event — the cross-platform robustness `fs.watch` lacks.
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Prune deps/build-output/VCS/tests and dotfile+editor-temp artifacts at the
    // directory level, so the watch never descends node_modules.
    ignored: (p: string) => {
      const rel = relOf(resolve(p))
      return rel !== '' && pruned(rel)
    },
    // 20 ms is enough to see a rename-style atomic save settle; a torn read
    // only costs one overlay, which the next settled write clears.
    awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
  })
  const onEvent = (event: 'add' | 'change' | 'unlink', p: string): void => {
    const abs = resolve(p)
    if (!isAppFile(abs)) return
    changed.add(abs)
    // add/unlink change the file SET → rescan; a plain edit stays incremental.
    if (event === 'add' || event === 'unlink') structural = true
    // Small debounce to coalesce a multi-file save (awaitWriteFinish already
    // settled each file, so this only groups a batch).
    clearTimeout(timer)
    timer = setTimeout(() => {
      const files = [...changed]
      const wasStructural = structural
      changed.clear()
      structural = false
      reloadChain = reloadChain.then(() => doRebuild(files, wasStructural))
    }, 20)
  }
  watcher.on('add', (p) => onEvent('add', p))
  watcher.on('change', (p) => onEvent('change', p))
  watcher.on('unlink', (p) => onEvent('unlink', p))

  let listening: ReturnType<typeof createHttpServer> | undefined
  let bootTeardown: BootTeardown | undefined
  let unhook: (() => void) | undefined
  const runBootTeardown = async (): Promise<void> => {
    const teardown = bootTeardown
    bootTeardown = undefined
    if (teardown) await teardown()
  }

  return {
    fetch: handle,
    get hono() {
      return app
    },
    dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
    listen(port: number): Promise<{ port: number }> {
      const listener = getRequestListener(handle)
      const server = createHttpServer(listener)
      listening = server
      return findFreePort(port).then(
        (freePort) =>
          new Promise((resolveFn) => {
            server.listen(freePort, async () => {
              // `listen(0)` asks the OS for a port; report the one it gave.
              const bound = (server.address() as AddressInfo).port
              printDevBanner({
                port: bound,
                requestedPort: port,
                machines: machineCount,
                routes: routes.length,
                inspector: inspectorOn,
              })
              const teardown: BootTeardown | undefined = await runBoot(bootDef, {
                dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
                config: {
                  origin: resolved.origin,
                  trustedOrigins: resolved.trustedOrigins ?? [],
                  sameSite: resolved.sameSite ?? 'Lax',
                  cors: resolved.cors,
                },
              })
              bootTeardown = teardown
              unhook = installGracefulShutdown(server, {
                teardown: async () => {
                  await runBootTeardown()
                  await watcher.close()
                },
              })
              resolveFn({ port: bound })
            })
          }),
      )
    },
    close: async () => {
      const server = listening
      listening = undefined
      unhook?.()
      unhook = undefined
      // The listening server and its open connections (a live page's SSE
      // stream, a keep-alive socket) would otherwise hold the process open.
      const teardown = async (): Promise<void> => {
        await runBootTeardown()
        await watcher.close()
      }
      if (server) await drainAndClose(server, { teardown })
      else await teardown()
      loader.deregister()
    },
  }
}

/** Error text for logs and the overlay — a located compile error renders with
 *  its file:line:column and code frame. */
function describe(err: unknown): string {
  if (err instanceof CompileError) return formatCompileError(err)
  return err instanceof Error ? err.message : String(err)
}
