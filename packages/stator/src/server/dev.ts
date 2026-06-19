import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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

  const cssCache = new Map<string, string>()
  const cssForFile = async (file: string): Promise<string> => {
    let css = cssCache.get(file)
    if (css === undefined) {
      css = compile(await readFile(file, 'utf8'), { id: file }).css
      cssCache.set(file, css)
    }
    return css
  }

  const app = await runtime.buildHonoApp({
    routes,
    store,
    staticDir: config.staticDir,
    headExtras: async (routeFile: string) => {
      const css = await collectStatorCss(vite, routeFile, cssForFile)
      return css ? `<style data-stator-dev>\n${css}\n</style>` : ''
    },
  })

  return {
    fetch: (request) => app.fetch(request),
    vite,
    listen(port: number): Promise<void> {
      return new Promise((resolveFn) => {
        serve({ fetch: app.fetch, port }, () => {
          logger.info({ port, mode: 'dev', machines: defs.length, routes: routes.length }, 'listening')
          resolveFn()
        })
      })
    },
    close: () => vite.close(),
  }
}

/**
 * Walk the SSR module graph from a route's file and collect the scoped CSS of
 * every `.stator` component reachable from it. CSS comes from the compiler
 * (same `{ id }` → same hash as the markers in the rendered HTML), not from
 * Vite's CSS-to-JS dev transform.
 */
async function collectStatorCss(
  vite: ViteDevServer,
  entryFile: string,
  cssForFile: (file: string) => Promise<string>,
): Promise<string> {
  const seen = new Set<string>()
  const statorFiles = new Set<string>()

  const visit = (node: { id: string | null; importedModules: Set<unknown> } | undefined): void => {
    if (!node) return
    const id = node.id ?? ''
    if (seen.has(id)) return
    seen.add(id)
    if (/\.stator$/.test(id)) statorFiles.add(id)
    for (const dep of node.importedModules) visit(dep as never)
  }

  for (const node of vite.moduleGraph.getModulesByFile(entryFile) ?? []) {
    visit(node as never)
  }

  let css = ''
  for (const file of statorFiles) {
    const chunk = await cssForFile(file)
    if (chunk) css += chunk + '\n'
  }
  return css.trim()
}
