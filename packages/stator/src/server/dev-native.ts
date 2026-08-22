import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { register } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import chokidar from 'chokidar'
import type { Hono } from 'hono'
import { bundleIslands, type IslandBundle, routeIslandMap, walkFiles } from '../build/islands.ts'
import { sourceId } from '../build/source-id.ts'
import { CompileError, compile, formatCompileError, regionResolverFor } from '../compiler/index.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { findFreePort, installGracefulShutdown, printDevBanner } from './banner.ts'
import { type BootTeardown, discoverBoot, runBoot } from './boot.ts'
import { resolveAppConfig } from './config-compat.ts'
import type { DevAppConfig } from './dev.ts'
import { findPollLoops } from './dev-lint.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { loadDotenv } from './env.ts'
import { buildHonoApp, contentTypeFor } from './http.ts'
import { logger, setLogLevel } from './logger.ts'
import { MachineStore } from './machine-store.ts'
import { discoverMiddleware } from './middleware.ts'
import { discoverRoutes } from './route-discovery.ts'
import { InMemoryStore } from './store.ts'

/**
 * Native dev server — the Vite exit (Option D). The server runs from the app's
 * SOURCE tree with no Vite and no mirror: `.stator` files are compiled on
 * import by `dev-loader.mjs` (the framework compiler + esbuild on Node's loader
 * hooks), machines/routes/middleware are discovered from their real paths, and
 * the app is served by Hono exactly as `stator start` serves a build. Because
 * nothing is copied, `import.meta.url`-relative paths in app code (a SQLite
 * file, a data dir) mean the same thing in dev as in prod.
 *
 * The dev-only capabilities Vite used to provide are reproduced natively:
 *  - **Live reload** — a source change bumps the module version (`?v=N`,
 *    propagated app-wide by the loader) so the next import of the app graph is
 *    fresh; connected browsers reload via a tiny SSE channel (`/__stator_dev`),
 *    replacing Vite's HMR websocket. A failed rebuild keeps the last good
 *    graph serving and renders the error (with its code frame) in an overlay.
 *  - **Scoped CSS + island scripts** — islands bundle through the
 *    `bundleIslands` seam (Vite today, never on the SSR path) and are served
 *    from memory with the concatenated scoped CSS, on the same URLs and with
 *    the same `<head>` shape as production.
 *
 * See spec `toolchain-adapter-seam-and-the-vite-exit`.
 */
export interface NativeDevApp {
  fetch: (request: Request) => Response | Promise<Response>
  readonly hono: Hono
  dispatchToApp<D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ): Promise<{ committed: boolean }>
  listen: (port: number) => Promise<void>
  close: () => Promise<void>
}

// The dev browser client (replaces Vite's `/@vite/client`): reconnecting-EventSource
// that reloads on a successful rebuild and renders a full-screen overlay with the
// message on a build failure, so a compile error is visible instead of a frozen page.
const DEV_CLIENT_SCRIPT = `(()=>{let o;const show=(m)=>{if(o)o.remove();o=document.createElement('div');o.style.cssText='position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:#1a1015;color:#f8d7da;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap';o.textContent='stator \\u2014 build failed\\n\\n'+m;document.body.appendChild(o)};const es=new EventSource('/__stator_dev');es.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='reload')location.reload();else if(m.type==='error')show(m.message)}})()`

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__'])
const APP_EXT = /\.(stator|ts|tsx|mts|cts|js|mjs)$/
/** Root-relative path segments that are never app source (mirrors SKIP_DIRS). */
const PRUNE_DIR = /(^|\/)(node_modules|dist|tests|test|__tests__)(\/|$)/
/** Any dot-prefixed segment: VCS/config dirs and editor temp/swap files. */
const DOT_SEGMENT = /(^|\/)\.[^/]+/
const EMPTY_BUNDLE: IslandBundle = { islandUrls: {}, assets: [], modules: [] }
const norm = (p: string): string => p.replace(/\\/g, '/')

export async function createNativeDevApp(config: DevAppConfig): Promise<NativeDevApp> {
  const root = resolve(config.root)
  loadDotenv(root)

  const resolved = resolveAppConfig(config)
  const logLevel = process.env.LOG_LEVEL ?? resolved.logLevel ?? 'info'
  setLogLevel(logLevel)
  const inspectorOn = resolved.inspector ?? true
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const staticDir = config.staticDir ? resolve(config.staticDir) : resolve(root, 'static')
  // One build-id per dev process, as the Vite dev server did — rebuilds reload
  // through the dev channel, a restart is a new id for the SSE reconnect handshake.
  const buildId = randomUUID()

  // Loaders, BEFORE the first app import. The CLI's TS loader first — a no-op
  // extra link when the CLI already registered it, required when the dev server
  // is started programmatically, because the dev loader (a hooks-thread module)
  // imports the TypeScript compiler source. Then the dev loader: `.stator`
  // compile-on-load plus `?v=` propagation scoped to the app root.
  register('../cli/loader.js', import.meta.url)
  register('./dev-loader.mjs', import.meta.url, { data: { appDir: root } })

  // A monotonic build version drives cache-busting: every rebuild bumps it, and
  // discovery imports entries at `?v=N` so the whole app graph is re-read fresh.
  let version = 1
  const bust = (file: string): Promise<Record<string, unknown>> =>
    import(`${pathToFileURL(file).href}?v=${version}`)

  // ── Dev live-reload channel (replaces Vite's `/@vite/client` HMR socket) ────
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
  }
  const devReloadResponse = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(': connected\n\n'))
          reloadClients.add(controller)
        },
        // A closed stream's controller throws on the next enqueue and is pruned then.
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

  // ── Source scan: scoped CSS + island-ness of every `.stator` ───────────────
  // The loader compiles each `.stator` into its server module on import; this
  // main-thread pass compiles for the two things the <head> needs up front —
  // scoped CSS and which files are islands. Same `sourceId`, so the scope
  // hashes agree with the markup the loader emits.
  interface StatorInfo {
    css: string
    isClient: boolean
  }
  const infos = new Map<string, StatorInfo>() // abs `.stator` → info
  const skipDir = (name: string): boolean => name.startsWith('.') || SKIP_DIRS.has(name)
  const compileInfo = async (file: string): Promise<StatorInfo> => {
    const source = await readFile(file, 'utf8')
    const { id, kind } = sourceId(root, file)
    const r = compile(source, { id, kind, resolveRegions: regionResolverFor(file, source) })
    return { css: r.css ?? '', isClient: r.isClient }
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
  let css = ''
  const regenCss = (): void => {
    css = ''
    for (const [file, info] of infos)
      if (info.css) css += `/* ${sourceId(root, file).id} */\n${info.css}\n`
  }

  // ── Islands: bundled through the seam, held in memory ──────────────────────
  let islands: IslandBundle = EMPTY_BUNDLE
  const assetBodies = new Map<string, string | Uint8Array>() // URL path → body
  let islandGraph = new Set<string>() // every source module in the last bundle
  let routeIslands = new Map<string, string[]>() // abs route file → island rels
  const islandFiles = (): string[] => [...infos].filter(([, i]) => i.isClient).map(([f]) => f)
  const rebundleIslands = async (): Promise<void> => {
    const entries = islandFiles().map((file) => ({ rel: sourceId(root, file).id, file }))
    islands = entries.length ? await bundleIslands({ root, machinesDir, entries }) : EMPTY_BUNDLE
    assetBodies.clear()
    for (const a of islands.assets) assetBodies.set(`/static/assets/${a.fileName}`, a.source)
    islandGraph = new Set(islands.modules)
  }
  const remapRoutes = async (): Promise<void> => {
    const shells = new Map(islandFiles().map((file) => [file, sourceId(root, file).id]))
    routeIslands = await routeIslandMap({ routesDir, baseDir: root, shells })
  }

  // Production head shape (CSS link + per-route island scripts), then the dev
  // inspector and the reload client layered on top.
  const headExtras = (routeFile: string): string => {
    const head: string[] = []
    if (css) head.push('<link rel="stylesheet" href="/static/components.css">')
    for (const rel of routeIslands.get(resolve(routeFile)) ?? []) {
      const url = islands.islandUrls[rel]
      if (url) head.push(`<script type="module" src="${url}"></script>`)
    }
    if (inspectorOn) head.push('<script src="/@stator/inspector.js" defer></script>')
    head.push(`<script>${DEV_CLIENT_SCRIPT}</script>`)
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
    if (pathname === '/static/components.css' && css)
      return new Response(css, { headers: noCache('text/css; charset=utf-8') })
    const body = assetBodies.get(pathname)
    if (body !== undefined)
      return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
        headers: noCache(contentTypeFor(pathname)),
      })
    return undefined
  }

  // ── App graph (rebuilt on edits) ────────────────────────────────────────────
  let store: MachineStore
  let routes: Awaited<ReturnType<typeof discoverRoutes>> = []
  let machineCount = 0
  let app: Hono
  const handle = (request: Request): Response | Promise<Response> =>
    serveDev(request) ?? app.fetch(request)

  const rebuildStore = async (): Promise<void> => {
    const { defs } = await discoverMachines(machinesDir, bust)
    machineCount = defs.length
    store = new MachineStore(defs, resolved.session ?? new InMemoryStore(), {
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
  }

  const rebuildServer = async (): Promise<void> => {
    routes = await discoverRoutes(routesDir, bust)
    const middleware = await discoverMiddleware(resolve(root, 'middleware.ts'), bust)
    await remapRoutes()
    app = await buildHonoApp({
      routes,
      store,
      staticDir,
      headExtras,
      inspector: inspectorOn,
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
  regenCss()
  await rebundleIslands()
  await rebuildStore()
  await rebuildServer()

  // boot.ts once per process (a long-lived source shouldn't restart on edits).
  const bootDef = await discoverBoot(resolve(root, 'boot.ts'), bust)

  // ── Watch → recompile → reload ──────────────────────────────────────────────
  // Recompile just what changed. Islands rebundle only when an edit touches a
  // module the last bundle contained (an island, or something it imports — the
  // seam reports exactly that set), a file became an island, or the file set
  // changed; machine edits rebuild the store; everything rebuilds the server
  // graph at the bumped version.
  const doRebuild = async (files: string[], structural: boolean): Promise<void> => {
    version++
    const t0 = performance.now()
    let rebundled = false
    let storeRebuilt = false
    try {
      if (structural) await scanAll()
      else for (const f of files) if (f.endsWith('.stator')) infos.set(f, await compileInfo(f))
      regenCss()
      const needsBundle =
        structural || files.some((f) => islandGraph.has(norm(f)) || infos.get(f)?.isClient)
      if (needsBundle) {
        await rebundleIslands()
        rebundled = true
      }
      if (files.some((f) => f.startsWith(machinesDir + sep))) {
        await rebuildStore()
        storeRebuilt = true
      }
      await rebuildServer()
      broadcast({ type: 'reload' })
      logger.info(
        {
          ms: Math.round(performance.now() - t0),
          islands: rebundled,
          store: storeRebuilt,
          routes: routes.length,
          files: files.map((f) => sourceId(root, f).id),
        },
        'reloaded',
      )
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

  // Prune rules apply to the path RELATIVE to the app root — the root's own
  // ancestors may legitimately contain a `tests/` or a dot-dir.
  const relOf = (abs: string): string => norm(relative(root, abs))
  const pruned = (rel: string): boolean =>
    rel.startsWith('..') || PRUNE_DIR.test(rel) || DOT_SEGMENT.test(rel)
  const isAppFile = (abs: string): boolean => APP_EXT.test(abs) && !pruned(relOf(abs))

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
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 10 },
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
    }, 40)
  }
  watcher.on('add', (p) => onEvent('add', p))
  watcher.on('change', (p) => onEvent('change', p))
  watcher.on('unlink', (p) => onEvent('unlink', p))

  return {
    fetch: handle,
    get hono() {
      return app
    },
    dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
    listen(port: number): Promise<void> {
      const listener = getRequestListener(handle)
      const server = createHttpServer(listener)
      return findFreePort(port).then(
        (freePort) =>
          new Promise((resolveFn) => {
            server.listen(freePort, async () => {
              printDevBanner({
                port: freePort,
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
              installGracefulShutdown(async () => {
                if (teardown) await teardown()
                await watcher.close()
                await new Promise<void>((done) => server.close(() => done()))
              })
              resolveFn()
            })
          }),
      )
    },
    close: () => watcher.close(),
  }
}

/** Error text for logs and the overlay — a located compile error renders with
 *  its file:line:column and code frame. */
function describe(err: unknown): string {
  if (err instanceof CompileError) return formatCompileError(err)
  return err instanceof Error ? err.message : String(err)
}
