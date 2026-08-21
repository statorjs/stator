import { watch } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { register } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import type { Hono } from 'hono'
import { buildApp, loadProductionHead } from '../build/index.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { findFreePort, installGracefulShutdown, printDevBanner } from './banner.ts'
import { type BootTeardown, discoverBoot, runBoot } from './boot.ts'
import { resolveAppConfig } from './config-compat.ts'
import type { DevAppConfig } from './dev.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { loadDotenv } from './env.ts'
import { buildHonoApp } from './http.ts'
import { logger, setLogLevel } from './logger.ts'
import { MachineStore } from './machine-store.ts'
import { discoverMiddleware } from './middleware.ts'
import { discoverRoutes } from './route-discovery.ts'
import { InMemoryStore } from './store.ts'

/**
 * Native dev server — the Vite exit (Option D). Runs the SSR path with NO Vite:
 * `.stator` is compiled by the framework's own compiler (via `buildApp`), the
 * server modules are imported natively through the esbuild `dev-loader.mjs`, and
 * the app is served by Hono exactly as `stator start` serves a production build.
 *
 * The two dev-only capabilities Vite used to provide are reproduced natively:
 *  - **Live reload** — a source change triggers a recompile + a bumped module
 *    version (`?v=N`, propagated app-wide by `dev-loader.mjs`) so the next import
 *    of the app graph is fresh; connected browsers reload via a tiny SSE channel
 *    (`/__stator_dev`), replacing Vite's HMR websocket.
 *  - **CSS + island `<head>` injection** — reused verbatim from the production
 *    path (`loadProductionHead` reads the build manifest); islands still bundle
 *    through Vite inside `buildApp` (the `bundleIslands` seam), never on the SSR
 *    path.
 *
 * See spec `toolchain-adapter-seam-and-the-vite-exit` §"Spike D".
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

export async function createNativeDevApp(config: DevAppConfig): Promise<NativeDevApp> {
  const root = resolve(config.root)
  loadDotenv(root)

  const resolved = resolveAppConfig(config)
  const logLevel = process.env.LOG_LEVEL ?? resolved.logLevel ?? 'info'
  setLogLevel(logLevel)
  const inspectorOn = resolved.inspector ?? true

  // Compiled output lives in a dev dir under the app so the emitted `.stator.ts`
  // and its bare `@statorjs/stator` imports resolve against the app's own
  // node_modules — exactly how `stator start` runs a build from the project tree.
  const outDir = resolve(root, '.stator-dev')
  const machinesDir = resolve(outDir, 'machines')
  const routesDir = resolve(outDir, 'routes')

  // Register the native loader BEFORE the first app import. Its `?v=`
  // propagation is scoped to `outDir` so only app modules re-import on a bump —
  // framework singletons stay single (the dual-instance guard, Spike D #4).
  register('./dev-loader.mjs', import.meta.url, { data: { appDir: outDir } })

  // A monotonic build version drives cache-busting: every rebuild bumps it, and
  // the discovery loader imports entries at `?v=N` so the whole app graph is
  // re-read fresh (propagation carries N to transitive imports).
  let version = 0
  const bust = (file: string): Promise<Record<string, unknown>> =>
    import(`${pathToFileURL(file).href}?v=${version}`)

  // ── Dev live-reload channel (replaces Vite's `/@vite/client` HMR socket) ────
  const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  const broadcastReload = (): void => {
    for (const c of reloadClients) {
      try {
        c.enqueue(enc.encode('data: reload\n\n'))
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
        cancel() {
          // controller identity differs on cancel; prune lazily on next broadcast
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

  // ── App graph (rebuilt on edits) ────────────────────────────────────────────
  let store: MachineStore
  let routes: Awaited<ReturnType<typeof discoverRoutes>> = []
  let machineCount = 0
  let app: Hono
  let buildId: string | undefined

  const recompile = async (): Promise<void> => {
    version++
    await buildApp({ root, outDir })
    // buildId is read from the freshly written manifest in rebuildServer.
  }

  const rebuildStore = async (): Promise<void> => {
    const { defs } = await discoverMachines(machinesDir, bust)
    machineCount = defs.length
    store = new MachineStore(defs, resolved.session ?? new InMemoryStore(), {
      sessionTtlSeconds: resolved.sessionTtlSeconds,
      appStore: resolved.app,
    })
    wireAppEffects(store)
    await store.bootAppMachines()
  }

  const rebuildServer = async (): Promise<void> => {
    routes = await discoverRoutes(routesDir, bust)
    const middleware = await discoverMiddleware(resolve(outDir, 'middleware.ts'), bust)
    // Reuse the production head (CSS link + per-route island scripts from the
    // manifest just written by buildApp); layer the dev inspector + reload script.
    const { headExtras: prodHead, buildId: manifestBuildId } = await loadProductionHead(outDir)
    buildId = manifestBuildId
    const headExtras = (routeFile: string): string => {
      const dev: string[] = []
      if (inspectorOn) dev.push('<script src="/@stator/inspector.js" defer></script>')
      dev.push(
        `<script>new EventSource('/__stator_dev').onmessage=(e)=>{if(e.data==='reload')location.reload()}</script>`,
      )
      return [prodHead(routeFile), ...dev].filter(Boolean).join('\n')
    }
    app = await buildHonoApp({
      routes,
      store,
      staticDir: resolve(outDir, 'static'),
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
    // Mount the dev reload channel ahead of everything else on the fresh app.
    app.get('/__stator_dev', () => devReloadResponse())
  }

  await recompile()
  await rebuildStore()
  await rebuildServer()

  // boot.ts once per process (a long-lived source shouldn't restart on edits).
  const bootDef = await discoverBoot(resolve(outDir, 'boot.ts'), bust)

  // ── Watch → recompile → reload ──────────────────────────────────────────────
  const isAppFile = (file: string): boolean => {
    if (!/\.(stator|ts|js|css)$/.test(file)) return false
    const abs = resolve(root, file)
    if (abs.startsWith(outDir)) return false
    if (abs.includes('/node_modules/') || abs.includes('/dist/') || abs.includes('/.git/'))
      return false
    return true
  }
  let pending = false
  let touchedMachine = false
  let reloadChain: Promise<void> = Promise.resolve()
  const flush = (): void => {
    if (!pending) return
    const machineEdit = touchedMachine
    pending = false
    touchedMachine = false
    reloadChain = reloadChain.then(async () => {
      try {
        await recompile()
        if (machineEdit) await rebuildStore()
        await rebuildServer()
        broadcastReload()
        logger.info('reloaded')
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'reload failed')
      }
    })
  }
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || !isAppFile(filename)) return
    if (resolve(root, filename).startsWith(resolve(root, 'machines'))) touchedMachine = true
    pending = true
    // Coalesce editor bursts (multiple events per save).
    setTimeout(flush, 120)
  })

  return {
    fetch: (request) => app.fetch(request),
    get hono() {
      return app
    },
    dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
    listen(port: number): Promise<void> {
      const listener = getRequestListener((req) => app.fetch(req))
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
                watcher.close()
                await new Promise<void>((done) => server.close(() => done()))
              })
              resolveFn()
            })
          }),
      )
    },
    close: async () => {
      watcher.close()
    },
  }
}
