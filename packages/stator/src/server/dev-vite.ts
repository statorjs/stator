import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { relative, resolve } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import type { Hono } from 'hono'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { compile } from '../compiler/index.ts'
import type { AnyMachineDef } from '../engine/index.ts'
import { machineStub, stator } from '../vite/index.ts'
import { findFreePort, installGracefulShutdown, printDevBanner } from './banner.ts'
import { resolveAppConfig } from './config-compat.ts'
import type { DevApp, DevAppConfig } from './dev.ts'
import { loadDotenv } from './env.ts'
import { logger, setLogLevel } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { isStatorQueryRoute } from './routing.ts'

/**
 * The TRANSITIONAL Vite-embedded dev server, kept for one minor behind
 * `STATOR_VITE_DEV=1` while the native dev server (`dev-native.ts`, the
 * default since the Vite exit) beds in. Deleted with the rest of the Vite
 * implementation once the escape hatch retires.
 *
 * Embeds Vite in middleware mode so `.stator` (and TS) modules are compiled on
 * the way in, loads machines + routes through `vite.ssrLoadModule`, and injects
 * each route's scoped component CSS into `<head>` at render time.
 *
 * Critically, the framework runtime itself is loaded *through Vite*
 * (`ssrLoadModule('@statorjs/stator/server')`), not imported natively — so the
 * render-context, machine defs, routes, and templates all share one module
 * instance. Importing the runtime natively here would create a second instance
 * whose render-context doesn't match the one the templates resolve against, and
 * `read()` would throw. (This mirrors how Astro/SvelteKit run SSR through Vite.)
 */
export async function createViteDevApp(config: DevAppConfig): Promise<DevApp> {
  // Load .env before anything reads process.env. No-op if the CLI already
  // loaded it; covers a direct `createDevApp` call (a hand-written dev entry).
  loadDotenv(resolve(config.root))
  // One build-id per dev boot — a `tsx` restart is a new process → new id → the
  // client reloads on reconnect (the restart-without-reload gap). An inner Vite
  // rebuild keeps the same id (no full reload; islands hot-reload via Vite).
  const devBuildId = randomUUID()
  // Vite's HMR websocket defaults to 24678 for EVERY dev server — two
  // stator apps side by side would fight over it (the loser's live reload
  // silently dies). Probe a free one instead.
  const hmrPort = await findFreePort(24678)
  const vite = await createViteServer({
    root: resolve(config.root),
    appType: 'custom',
    // Ignore a user `vite.config.*` — the production build already sets this,
    // and reading it only in dev is a dev/prod divergence footgun (a plugin
    // configured there would run in `stator dev` and silently vanish in
    // `stator build`). Stator's own plugins are passed inline below.
    configFile: false,
    server: { middlewareMode: true, hmr: { port: hmrPort } },
    // machineStub keeps server machines out of browser module graphs: island
    // imports of a machine resolve to a `{ name }` stub (SSR loads are
    // untouched — `options.ssr` gates it).
    plugins: [stator(), machineStub({ machinesDir: resolve(config.machinesDir) })],
    // The framework's own source is TS that Vite must transform, not externalize.
    ssr: { noExternal: [/@statorjs\/stator/] },
    logLevel: 'warn',
  })

  // Load the runtime through Vite so it shares an instance with the templates.
  // (Type-only: the static import type is erased, so no second instance.)
  const runtime = (await vite.ssrLoadModule(
    '@statorjs/stator/server',
  )) as typeof import('./index.ts')
  const loader = (file: string) => vite.ssrLoadModule(file) as Promise<Record<string, unknown>>

  const root = resolve(config.root)
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const resolved = resolveAppConfig(config)
  // Level precedence: LOG_LEVEL env > config > dev default (info). Apply to this
  // module's logger AND the Vite-loaded runtime instance — SSE/http/effects log
  // through the latter — via setLogLevel, which also covers the scoped children.
  const logLevel = process.env.LOG_LEVEL ?? resolved.logLevel ?? 'info'
  setLogLevel(logLevel)
  runtime.setLogLevel(logLevel)
  // The session cookie is written by the Vite-loaded runtime, so configure that
  // instance's SameSite (the native one would set a different module's global).
  runtime.setSessionSameSite(resolved.sameSite ?? 'Lax')
  const inspectorOn = resolved.inspector ?? true
  // One session store for the life of the dev process. Rebuilds swap the
  // MachineStore AROUND it, so sessions survive an edit unless their machine's
  // code hash changed (hydration policy). Creating the default store inside
  // rebuildStore would silently reset every session on any machine-touching
  // edit — the opposite of what the per-machine hash promises.
  const sessionStore = resolved.session ?? new runtime.InMemoryStore()

  const resultCache = new Map<string, ReturnType<typeof compile>>()
  const compiledFor = async (file: string) => {
    let r = resultCache.get(file)
    if (r === undefined) {
      // Match the plugin's kind detection so route-page frontmatter
      // (Stator.reads etc.) compiles under the route capability set.
      const kind = /[\\/]routes[\\/].*\.stator$/.test(file) ? 'route' : 'component'
      r = compile(await readFile(file, 'utf8'), { id: file, kind })
      resultCache.set(file, r)
    }
    return r
  }

  const headExtras = async (routeFile: string) => {
    const files = reachableStatorFiles(vite, routeFile)
    let css = ''
    const scripts: string[] = []
    for (const f of files) {
      const r = await compiledFor(f)
      if (r.css) css += `/* ${f} */\n${r.css}\n`
      if (r.isClient) {
        // Vite's transform middleware compiles this URL because browsers send
        // `Sec-Fetch-Dest: script` for module scripts (the `.stator` extension
        // alone wouldn't match its JS-request check). curl-style probes must
        // send that header or they'll see raw source and cry wolf.
        const url = `/${relative(root, f).replace(/\\/g, '/')}?stator&type=client`
        scripts.push(`<script type="module" src="${url}"></script>`)
      }
    }
    const head: string[] = []
    // Vite's HMR client — pages are rendered by Hono, not Vite's
    // transformIndexHtml, so it isn't injected for us. Without it the browser
    // has no socket to receive the full-reload signal on a source change.
    head.push('<script type="module" src="/@vite/client"></script>')
    // The dev inspector toolbar (off in production — only the dev server injects it).
    if (inspectorOn) head.push('<script src="/@stator/inspector.js" defer></script>')
    if (css.trim()) head.push(`<style data-stator-dev>\n${css.trim()}\n</style>`)
    head.push(...scripts)
    return head.join('\n')
  }

  // The app graph is rebuilt on a source change so edits don't need a restart.
  let store: MachineStore
  let routes: DiscoveredRoute[] = []
  let machineCount = 0
  let defs: AnyMachineDef[] = []
  let app: Hono

  // Which machines' code hashes changed across a store rebuild — the sessions
  // of exactly those start fresh on their next request (hydration policy).
  // Hashes are read through the Vite-loaded runtime: its registry instance is
  // the one discovery populated (the native import would be a second, empty one).
  const rebuildStore = async (): Promise<string[]> => {
    const before = new Map(defs.map((d) => [d.name, runtime.codeHashOf(d)]))
    defs = (await runtime.discoverMachines(machinesDir, loader)).defs
    machineCount = defs.length
    const changed = defs
      .filter((d) => before.has(d.name) && before.get(d.name) !== runtime.codeHashOf(d))
      .map((d) => d.name)
    store = new runtime.MachineStore(defs, sessionStore, {
      sessionTtlSeconds: resolved.sessionTtlSeconds,
      appStore: resolved.app,
    })
    // Wire the effect scheduler before booting — a fresh app machine's
    // initial-state entry effect fires during boot and needs a live scheduler.
    runtime.wireAppEffects(store)
    await store.bootAppMachines()
    // Dev-only lint: a session machine whose `after` timer drives a loop with
    // a data-loading entry effect is server-side polling that runs for
    // sessions nobody is watching. Warn with the steer, don't block.
    for (const f of runtime.findPollLoops(defs)) {
      console.warn(
        `stator: session machine "${f.machine}" self-reschedules through \`after\` ` +
          `(${f.cycle.join(' → ')} via ${f.event}) with a data-loading entry effect on the loop. ` +
          `This polls upstream for sessions nobody is watching. Prefer a client-owned clock ` +
          `with a staleness guard — see the effects guide, "Who owns the clock".`,
      )
    }
    return changed
  }
  // An edit touches a machine when the file is in that machine's hashed
  // closure — the machine file itself or anything it imports.
  const touchesMachine = (file: string): boolean =>
    file.startsWith(machinesDir) || defs.some((d) => runtime.codeInputsOf(d).includes(file))
  const rebuildRoutes = async (): Promise<void> => {
    routes = await runtime.discoverRoutes(routesDir, loader)
    // Vite serves `public/` at the root ahead of Hono in dev, so a static
    // file at a data route's URL silently wins. Warn at discovery time.
    // (The brand is a plain property, so this native-import check works on
    // defs the Vite-loaded runtime created.)
    for (const r of routes) {
      if (!r.GET || !isStatorQueryRoute(r.GET) || r.paramNames.length > 0) continue
      if (existsSync(resolve(root, 'public', r.urlPath.slice(1)))) {
        console.warn(
          `stator: public/${r.urlPath.slice(1)} shadows the data route ${r.urlPath} in dev — ` +
            `the static file wins. Rename one of them.`,
        )
      }
    }
  }
  const rebuildServer = async (): Promise<void> => {
    // Re-discover `middleware.ts` each rebuild so edits to it take effect. Loaded
    // through the Vite runtime so its handlers share the runtime's instance.
    const middleware = await runtime.discoverMiddleware(resolve(root, 'middleware.ts'), loader)
    app = await runtime.buildHonoApp({
      routes,
      store,
      staticDir: config.staticDir,
      headExtras,
      inspector: inspectorOn,
      inspect: true,
      trustedOrigins: resolved.trustedOrigins,
      sameSite: resolved.sameSite,
      origin: resolved.origin,
      secret: resolved.secret,
      buildId: devBuildId,
      cors: resolved.cors,
      middleware,
    })
  }

  await rebuildStore()
  await rebuildRoutes()
  await rebuildServer()

  // Discover boot.ts ONCE per process (not per rebuild) — a long-lived source
  // shouldn't restart on every edit. Runs in listen() below.
  const bootDef = await runtime.discoverBoot(resolve(root, 'boot.ts'), loader)

  // Live reload: on a relevant source change, re-discover and rebuild the app,
  // then tell the browser to reload. A template/route edit keeps the store (and
  // your session — cart contents and all) intact; only a machine edit resets it,
  // since route `reads:` bind to machine defs by identity and must re-bind as a
  // set. Rebuilds are serialized so overlapping saves can't race.
  const isAppFile = (file: string): boolean => {
    if (!/\.(stator|ts|js)$/.test(file)) return false
    if (file.includes('/node_modules/') || file.includes('/dist/')) return false
    if (file.startsWith(machinesDir) || file.startsWith(routesDir)) return true
    return (vite.moduleGraph.getModulesByFile(file)?.size ?? 0) > 0
  }
  let reloadChain: Promise<void> = Promise.resolve()
  const onChange = (file: string): void => {
    const abs = resolve(file)
    if (!isAppFile(abs)) return
    reloadChain = reloadChain.then(async () => {
      invalidateModuleTree(vite, abs)
      resultCache.delete(abs)
      try {
        let machinesChanged: string[] | undefined
        if (touchesMachine(abs)) machinesChanged = await rebuildStore()
        await rebuildRoutes()
        await rebuildServer()
        vite.ws.send({ type: 'full-reload' })
        logger.info({ file: relative(root, abs) }, 'reloaded')
        if (machinesChanged) {
          logger.info(
            { machines: machinesChanged },
            machinesChanged.length
              ? 'machine code changed — their sessions start fresh on the next request'
              : 'machine files changed but no machine code changed — sessions carry over',
          )
        }
      } catch (err) {
        logger.error({ err: (err as Error).message, file: relative(root, abs) }, 'reload failed')
      }
    })
  }
  vite.watcher.on('change', onChange)
  vite.watcher.on('add', onChange)
  vite.watcher.on('unlink', onChange)

  return {
    fetch: (request) => app.fetch(request),
    get hono() {
      return app
    },
    vite,
    // `store` is read at call time, not captured — a machine-edit rebuild
    // swaps it and the method follows.
    dispatchToApp: (machine, event) => runtime.dispatchToApp(store, machine, event),
    listen(port: number): Promise<void> {
      // Vite's middlewares serve client modules + HMR to the browser; anything
      // it doesn't handle (routes, /__events, /__sse) falls through to Hono.
      // The arrow re-reads `app` each request so a rebuild swaps in seamlessly.
      const honoListener = getRequestListener((req) => app.fetch(req))
      const server = createHttpServer((req, res) => {
        vite.middlewares(req, res, () => honoListener(req, res))
      })
      // Busy port? Shift up like every modern dev server (the requested
      // port is someone's other project, not an error).
      return findFreePort(port).then(
        (freePort) =>
          new Promise((resolveFn) => {
            server.listen(freePort, async () => {
              printDevBanner({
                port: freePort,
                requestedPort: port,
                machines: machineCount,
                routes: routes.length,
                inspector: true,
              })
              // Boot runs once the dev server is up (store is read at call time,
              // so a later rebuild's store is used). Teardown composes into the
              // shutdown below.
              const teardown = await runtime.runBoot(bootDef, {
                dispatchToApp: (machine, event) => runtime.dispatchToApp(store, machine, event),
                config: {
                  origin: resolved.origin,
                  trustedOrigins: resolved.trustedOrigins ?? [],
                  sameSite: resolved.sameSite ?? 'Lax',
                  cors: resolved.cors,
                },
              })
              installGracefulShutdown(async () => {
                if (teardown) await teardown()
                await vite.close()
                await new Promise<void>((done) => server.close(() => done()))
              })
              resolveFn()
            })
          }),
      )
    },
    close: () => vite.close(),
  }
}

/** Invalidate a changed file and everything that (transitively) imports it, so
 *  the next `ssrLoadModule` re-executes them with fresh code. */
function invalidateModuleTree(vite: ViteDevServer, file: string): void {
  const seen = new Set<unknown>()
  const stack: Array<{ importers: Set<unknown> }> = [
    ...((vite.moduleGraph.getModulesByFile(file) ?? []) as Set<never>),
  ]
  while (stack.length) {
    const mod = stack.pop()
    if (!mod || seen.has(mod)) continue
    seen.add(mod)
    vite.moduleGraph.invalidateModule(mod as never)
    for (const imp of mod.importers) stack.push(imp as never)
  }
}

/**
 * Walk the SSR module graph from a route's file and return every `.stator` file
 * reachable from it (route page + the components it renders). The caller compiles
 * each to collect scoped CSS and client-component module scripts.
 */
function reachableStatorFiles(vite: ViteDevServer, entryFile: string): string[] {
  const seen = new Set<string>()
  const statorFiles = new Set<string>()

  const visit = (node: { id: string | null; importedModules: Set<unknown> } | undefined): void => {
    if (!node) return
    const id = node.id ?? ''
    if (seen.has(id)) return
    seen.add(id)
    const file = id.split('?')[0]!
    if (/\.stator$/.test(file)) statorFiles.add(file)
    for (const dep of node.importedModules) visit(dep as never)
  }

  for (const node of vite.moduleGraph.getModulesByFile(entryFile) ?? []) {
    visit(node as never)
  }
  return [...statorFiles]
}
