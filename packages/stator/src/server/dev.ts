import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { getRequestListener } from '@hono/node-server'
import { createServer as createHttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { stator } from '../vite/index.ts'
import { compile } from '../compiler/index.ts'
import { logger } from './logger.ts'
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
  const runtime = (await vite.ssrLoadModule('@statorjs/stator/server')) as any
  const loader = (file: string) =>
    vite.ssrLoadModule(file) as Promise<Record<string, unknown>>

  const { defs } = await runtime.discoverMachines(config.machinesDir, loader)
  const store = new runtime.MachineStore(defs, config.store ?? new runtime.InMemoryStore(), {
    sessionTtlSeconds: config.sessionTtlSeconds,
  })
  store.bootAppMachines()
  const routes = await runtime.discoverRoutes(config.routesDir, loader)

  const root = resolve(config.root)
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

  const app = await runtime.buildHonoApp({
    routes,
    store,
    staticDir: config.staticDir,
    headExtras: async (routeFile: string) => {
      const files = reachableStatorFiles(vite, routeFile)
      let css = ''
      const scripts: string[] = []
      for (const f of files) {
        const r = await compiledFor(f)
        if (r.css) css += `/* ${f} */\n${r.css}\n`
        if (r.isClient) {
          const url = '/' + relative(root, f).replace(/\\/g, '/') + '?' + 'stator&type=client'
          scripts.push(`<script type="module" src="${url}"></script>`)
        }
      }
      const head: string[] = []
      if (css.trim()) head.push(`<style data-stator-dev>\n${css.trim()}\n</style>`)
      head.push(...scripts)
      return head.join('\n')
    },
  })

  return {
    fetch: (request) => app.fetch(request),
    vite,
    listen(port: number): Promise<void> {
      // Vite's middlewares serve client modules + HMR to the browser; anything
      // it doesn't handle (routes, /__events, /__sse) falls through to Hono.
      const honoListener = getRequestListener(app.fetch)
      const server = createHttpServer((req, res) => {
        vite.middlewares(req, res, () => honoListener(req, res))
      })
      return new Promise((resolveFn) => {
        server.listen(port, () => {
          logger.info({ port, mode: 'dev', machines: defs.length, routes: routes.length }, 'listening')
          resolveFn()
        })
      })
    },
    close: () => vite.close(),
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
