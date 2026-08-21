import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { register } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import chokidar from 'chokidar'
import type { Hono } from 'hono'
import { buildApp, loadProductionHead } from '../build/index.ts'
import { compile } from '../compiler/index.ts'
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

// The dev browser client (replaces Vite's `/@vite/client`): reconnecting-EventSource
// that reloads on a successful rebuild and renders a full-screen overlay with the
// message on a build failure, so a compile error is visible instead of a frozen page.
const DEV_CLIENT_SCRIPT = `(()=>{let o;const show=(m)=>{if(o)o.remove();o=document.createElement('div');o.style.cssText='position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:#1a1015;color:#f8d7da;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap';o.textContent='stator \\u2014 build failed\\n\\n'+m;document.body.appendChild(o)};const es=new EventSource('/__stator_dev');es.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='reload')location.reload();else if(m.type==='error')show(m.message)}})()`

export async function createNativeDevApp(config: DevAppConfig): Promise<NativeDevApp> {
  const root = resolve(config.root)
  loadDotenv(root)

  const resolved = resolveAppConfig(config)
  const logLevel = process.env.LOG_LEVEL ?? resolved.logLevel ?? 'info'
  setLogLevel(logLevel)
  const inspectorOn = resolved.inspector ?? true

  // Compiled output lives under the app (so the emitted `.stator.ts` and its bare
  // `@statorjs/stator` imports resolve against the app's own node_modules, like
  // `stator start`), in a per-PROCESS subdir. That lets several `stator dev`
  // instances run side by side — each on its own auto-incremented port AND its
  // own output tree — without corrupting each other's builds.
  const devRoot = resolve(root, '.stator-dev')
  const outDir = resolve(devRoot, String(process.pid))
  const machinesDir = resolve(outDir, 'machines')
  const routesDir = resolve(outDir, 'routes')

  // Make the dev output self-ignoring so users never have to touch their
  // .gitignore — `.stator-dev/.gitignore` with `*` hides the whole tree.
  await mkdir(devRoot, { recursive: true })
  await writeFile(join(devRoot, '.gitignore'), '*\n')

  // Sweep output dirs left behind by dev servers that have since exited (crash or
  // kill), so `.stator-dev/` doesn't accumulate cruft. Liveness-checked by PID.
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, not ours to signal
    }
  }
  for (const name of await readdir(devRoot).catch(() => [] as string[])) {
    const pid = Number(name)
    if (pid && pid !== process.pid && !isAlive(pid))
      await rm(resolve(devRoot, name), { recursive: true, force: true }).catch(() => {})
  }
  const cleanup = (): Promise<void> => rm(outDir, { recursive: true, force: true }).catch(() => {})

  // Register the native loader BEFORE the first app import. Its `?v=`
  // propagation is scoped to `outDir` so only app modules re-import on a bump —
  // framework singletons stay single (the dual-instance guard, Spike D #4).
  register('./dev-loader.mjs', import.meta.url, { data: { appDir: outDir } })

  // A monotonic build version drives cache-busting: every rebuild bumps it, and
  // the discovery loader imports entries at `?v=N` so the whole app graph is
  // re-read fresh (propagation carries N to transitive imports).
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

  // ── Incremental build ───────────────────────────────────────────────────────
  // Native dev compiles `.stator` from the SOURCE tree straight into outDir's
  // `.stator.ts` mirror (no `.stator` ever in outDir, so discovery can't
  // double-count). The slow part — the Vite island bundle inside buildApp — runs
  // ONLY on a full build; a plain server/template edit takes the fast path
  // (compile + css, no Vite), so per-edit latency is independent of island count.
  const machinesSrcDir = resolve(root, 'machines')
  const cssBySource = new Map<string, string>() // abs .stator → its scoped css
  const islandRels = new Set<string>() // root-relative `.stator` paths that are islands
  const relOf = (abs: string): string => relative(root, abs).replace(/\\/g, '/')
  const kindOf = (r: string): 'route' | 'component' =>
    /(^|\/)routes\//.test(r) ? 'route' : 'component'
  const rewriteStatorSpecifiers = (code: string): string =>
    code.replace(/(['"])([^'"]+\.stator)\1/g, '$1$2.ts$1')

  const APP_EXT = /\.(stator|ts|tsx|mts|cts|js|css)$/
  const EXCLUDE_DIR = new Set(['node_modules', 'dist', 'tests', 'test', '__tests__'])
  const walkApp = async (dir: string, out: string[] = []): Promise<string[]> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (EXCLUDE_DIR.has(e.name) || e.name.startsWith('.')) continue
        await walkApp(join(dir, e.name), out)
      } else if (APP_EXT.test(e.name)) {
        out.push(join(e.parentPath, e.name))
      }
    }
    return out
  }
  // Top-level dirs to mirror into outDir — excludes dist/hidden/tests so a stale
  // `dist/` or the `.stator-dev/` output is never copied into the build.
  const sourceDirs = async (): Promise<string[]> =>
    (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !EXCLUDE_DIR.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)

  // Compile one `.stator` source into its outDir `.stator.ts` (+ `.client.ts` for
  // an island). Returns css + island flag for the caller's bookkeeping.
  const compileStatorTo = async (src: string): Promise<{ css: string; isClient: boolean }> => {
    const r = relOf(src)
    const result = compile(await readFile(src, 'utf8'), { id: r, kind: kindOf(r) })
    const outBase = join(outDir, r)
    await mkdir(dirname(outBase), { recursive: true })
    await writeFile(`${outBase}.ts`, rewriteStatorSpecifiers(result.serverCode))
    if (result.isClient)
      await writeFile(`${outBase}.client.ts`, rewriteStatorSpecifiers(result.clientCode))
    return { css: result.css ?? '', isClient: result.isClient }
  }

  const writeComponentsCss = async (): Promise<void> => {
    let css = ''
    for (const [src, c] of cssBySource) if (c) css += `/* ${relOf(src)} */\n${c}\n`
    if (css) {
      await mkdir(join(outDir, 'static'), { recursive: true })
      await writeFile(join(outDir, 'static', 'components.css'), css)
    }
  }

  // Raw `.ts`/`.js` (machines, lib) are served as-is by the loader; mirror the one
  // changed file into outDir, rewriting any `.stator` specifier it imports.
  const copyTs = async (src: string): Promise<void> => {
    const out = join(outDir, relOf(src))
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, rewriteStatorSpecifiers(await readFile(src, 'utf8')))
  }
  const copyAsset = async (src: string): Promise<void> => {
    const out = join(outDir, relOf(src))
    await mkdir(dirname(out), { recursive: true })
    await cp(src, out)
  }

  // Re-derive css + island tracking from the source tree (after a full build).
  const seedState = async (): Promise<void> => {
    cssBySource.clear()
    islandRels.clear()
    for (const src of await walkApp(root)) {
      if (!src.endsWith('.stator')) continue
      const r = relOf(src)
      const result = compile(await readFile(src, 'utf8'), { id: r, kind: kindOf(r) })
      cssBySource.set(src, result.css ?? '')
      if (result.isClient) islandRels.add(r)
    }
  }

  // Full build — clean compile + Vite island bundle + manifest. Used at boot and
  // for island/structural changes (added/removed files, island client edits).
  const fullBuild = async (): Promise<void> => {
    await buildApp({ root, outDir, dirs: await sourceDirs() })
    await seedState()
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
      dev.push(`<script>${DEV_CLIENT_SCRIPT}</script>`)
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

  await fullBuild()
  await rebuildStore()
  await rebuildServer()

  // boot.ts once per process (a long-lived source shouldn't restart on edits).
  const bootDef = await discoverBoot(resolve(outDir, 'boot.ts'), bust)

  // ── Watch → recompile → reload ──────────────────────────────────────────────
  const isAppFile = (abs: string): boolean => {
    if (!APP_EXT.test(abs)) return false
    if (abs.startsWith(outDir)) return false
    if (abs.includes('/node_modules/') || abs.includes('/dist/') || abs.includes('/.git/'))
      return false
    // Ignore editor temp/swap artifacts — atomic saves (`sed`, vim `.swp`, some
    // editors) write a dotfile beside the target; only the real file matters.
    if (abs.slice(abs.lastIndexOf('/') + 1).startsWith('.')) return false
    return true
  }

  // Recompile just what changed. Server/template edits + machine edits take the
  // fast path (compile/copy, no Vite); island client edits, added/removed files,
  // and a template that just became an island fall back to a full build.
  const doRebuild = async (files: string[], structural: boolean): Promise<void> => {
    version++
    const t0 = performance.now()
    let mode: 'full' | 'fast' = 'fast'
    try {
      const statorChanged = files.filter((f) => f.endsWith('.stator'))
      const machineEdit = files.some((f) => f.startsWith(machinesSrcDir))
      const touchesIsland = statorChanged.some((f) => islandRels.has(relOf(f)))
      if (structural || touchesIsland) {
        mode = 'full'
        await fullBuild()
      } else {
        let cssTouched = false
        let becameIsland = false
        for (const f of files) {
          if (f.endsWith('.stator')) {
            const { css, isClient } = await compileStatorTo(f)
            cssBySource.set(f, css)
            cssTouched = true
            if (isClient) becameIsland = true
          } else if (/\.(ts|tsx|mts|cts|js)$/.test(f)) {
            await copyTs(f)
          } else {
            await copyAsset(f)
          }
        }
        // A template that gained a `<script>` needs its island bundled — fall back.
        if (becameIsland) {
          mode = 'full'
          await fullBuild()
        } else if (cssTouched) await writeComponentsCss()
      }
      // machineEdit already covers machine add/remove (they live under machines/),
      // so a non-machine structural change (new template) keeps the session.
      if (machineEdit) await rebuildStore()
      await rebuildServer()
      broadcast({ type: 'reload' })
      logger.info(
        {
          ms: Math.round(performance.now() - t0),
          mode,
          routes: routes.length,
          files: files.map(relOf),
        },
        'reloaded',
      )
    } catch (err) {
      // Keep serving the last good build, but surface the failure in the browser
      // (a compile/import error) instead of silently freezing on the old page.
      const message = (err as Error).message
      logger.error({ err: message, mode, structural, files: files.map(relOf) }, 'reload failed')
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
    // Prune deps/build-output/VCS and dotfile+editor-temp artifacts. Pruning at
    // the dir level keeps the watch cheap (never descends node_modules).
    ignored: (p: string) =>
      /(^|[\\/])(node_modules|dist|\.git|\.stator-dev)([\\/]|$)/.test(p) ||
      /[\\/]\.[^\\/]+$/.test(p),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 10 },
  })
  const onEvent = (event: 'add' | 'change' | 'unlink', p: string): void => {
    const abs = resolve(p)
    if (!isAppFile(abs)) return
    changed.add(abs)
    // add/unlink change the file SET → full build; a plain edit stays fast.
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
                await watcher.close()
                await cleanup()
                await new Promise<void>((done) => server.close(() => done()))
              })
              resolveFn()
            })
          }),
      )
    },
    close: async () => {
      await watcher.close()
      await cleanup()
    },
  }
}
