import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { relative, resolve } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import type { Hono } from 'hono'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { compile } from '../compiler/index.ts'
import { stator } from '../vite/index.ts'
import { logger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import type { Store } from './store.ts'

/**
 * Dev server: embeds Vite in middleware mode so `.stator` (and TS) modules are
 * compiled on the way in, loads machines + routes through `vite.ssrLoadModule`,
 * and injects each route's scoped component CSS into `<head>` at render time
 * (SSR head injection — independent of the client JS bundle).
 *
 * Critically, the framework runtime itself is loaded *through Vite*
 * (`ssrLoadModule('@statorjs/stator/server')`), not imported natively — so the
 * render-context, machine defs, routes, and templates all share one module
 * instance. Importing the runtime natively here would create a second instance
 * whose render-context doesn't match the one the templates resolve against, and
 * `read()` would throw. (This mirrors how Astro/SvelteKit run SSR through Vite.)
 *
 * The production serve path (pre-built assets + manifest, no Vite) is a separate
 * follow-up; this is the dev half of Phase 3a.
 */

export interface DevAppConfig {
  /** Vite root — the app directory (must reach node_modules for resolution). */
  root: string
  machinesDir: string
  routesDir: string
  staticDir?: string
  store?: Store
  sessionTtlSeconds?: number
  /** Auto-inject the dev inspector toolbar. On by default; set false to disable. */
  inspector?: boolean
}

export interface DevApp {
  fetch: (request: Request) => Response | Promise<Response>
  vite: ViteDevServer
  listen: (port: number) => Promise<void>
  close: () => Promise<void>
}

export async function createDevApp(config: DevAppConfig): Promise<DevApp> {
  const vite = await createViteServer({
    root: resolve(config.root),
    appType: 'custom',
    server: { middlewareMode: true },
    plugins: [stator()],
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
  const inspectorOn = config.inspector ?? true

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
  let app: Hono

  const rebuildStore = async (): Promise<void> => {
    const { defs } = await runtime.discoverMachines(machinesDir, loader)
    machineCount = defs.length
    store = new runtime.MachineStore(defs, config.store ?? new runtime.InMemoryStore(), {
      sessionTtlSeconds: config.sessionTtlSeconds,
    })
    store.bootAppMachines()
  }
  const rebuildRoutes = async (): Promise<void> => {
    routes = await runtime.discoverRoutes(routesDir, loader)
  }
  const rebuildServer = async (): Promise<void> => {
    app = await runtime.buildHonoApp({
      routes,
      store,
      staticDir: config.staticDir,
      headExtras,
      inspector: inspectorOn,
    })
  }

  await rebuildStore()
  await rebuildRoutes()
  await rebuildServer()

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
        if (abs.startsWith(machinesDir)) await rebuildStore()
        await rebuildRoutes()
        await rebuildServer()
        vite.ws.send({ type: 'full-reload' })
        logger.info({ file: relative(root, abs) }, 'reloaded')
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
    vite,
    listen(port: number): Promise<void> {
      // Vite's middlewares serve client modules + HMR to the browser; anything
      // it doesn't handle (routes, /__events, /__sse) falls through to Hono.
      // The arrow re-reads `app` each request so a rebuild swaps in seamlessly.
      const honoListener = getRequestListener((req) => app.fetch(req))
      const server = createHttpServer((req, res) => {
        vite.middlewares(req, res, () => honoListener(req, res))
      })
      return new Promise((resolveFn) => {
        server.listen(port, () => {
          logger.info(
            {
              port,
              mode: 'dev',
              machines: machineCount,
              routes: routes.length,
            },
            'listening',
          )
          resolveFn()
        })
      })
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
