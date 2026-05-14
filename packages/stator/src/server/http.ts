import { Hono } from 'hono'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import type { MachineStore } from './machine-store.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { renderRoute } from './render.ts'
import { recompute } from './recompute.ts'
import { getOrCreateSessionId } from './session.ts'
import { SessionRuntime } from './session-runtime.ts'
import type { RouteDefinition } from './routing.ts'

export interface HttpConfig {
  routes: DiscoveredRoute[]
  store: MachineStore
  staticDir?: string
}

const eventSchema = z.object({
  machine: z.string(),
  event: z
    .object({
      type: z.string(),
    })
    .passthrough(),
})

/**
 * Per-session async lock. Serializes event processing for a single session
 * so two concurrent POSTs can't race against each other's load → mutate →
 * persist cycle. GETs are read-only and do not acquire the lock.
 */
const sessionLocks = new Map<string, Promise<unknown>>()

function withSessionLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sid) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  sessionLocks.set(sid, settled)
  void settled.then(() => {
    if (sessionLocks.get(sid) === settled) sessionLocks.delete(sid)
  })
  return next
}

export async function buildHonoApp(config: HttpConfig): Promise<Hono> {
  const app = new Hono()
  const clientJs = await bundleClient()

  // Index routes by routeKey (`"GET /cart"`) so the POST handler can look
  // up the route the client is currently on and use its `reads:` to drive
  // selective machine hydration.
  const routesByKey = new Map<string, { route: RouteDefinition; urlPath: string }>()
  for (const r of config.routes) {
    if (r.GET) routesByKey.set(`GET ${r.urlPath}`, { route: r.GET, urlPath: r.urlPath })
  }

  app.get('/static/client.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    return c.body(clientJs)
  })

  if (config.staticDir) {
    const staticDir = config.staticDir
    app.get('/static/*', async (c) => {
      const rel = c.req.path.replace(/^\/static\//, '')
      if (rel.includes('..')) return c.text('forbidden', 403)
      try {
        const buf = await readFile(resolve(staticDir, rel))
        c.header('Content-Type', contentTypeFor(rel))
        return c.body(buf)
      } catch {
        return c.text('not found', 404)
      }
    })
  }

  for (const route of config.routes) {
    if (!route.GET) continue
    const get = route.GET
    const urlPath = route.urlPath
    app.get(urlPath, async (c) => {
      const { sessionId } = getOrCreateSessionId(c)
      const routeKey = `GET ${urlPath}`
      const runtime = new SessionRuntime(sessionId, config.store)
      try {
        await runtime.loadGraph(get.reads)
        const result = renderRoute(get, routeKey, sessionId, runtime)
        return c.html(result.html)
      } finally {
        runtime.dispose()
      }
    })
  }

  app.post('/__events', async (c) => {
    const { sessionId } = getOrCreateSessionId(c)
    const routeKey = c.req.header('X-Stator-Route')
    if (!routeKey) {
      return c.json({ error: 'missing X-Stator-Route header' }, 400)
    }
    const routeEntry = routesByKey.get(routeKey)
    if (!routeEntry) {
      return c.json({ error: `unknown route "${routeKey}"` }, 404)
    }

    let body: z.infer<typeof eventSchema>
    try {
      body = eventSchema.parse(await c.req.json())
    } catch (e) {
      return c.json({ error: 'invalid event payload', detail: String(e) }, 400)
    }

    const originDef = config.store.getDef(body.machine)
    if (!originDef) {
      return c.json({ error: `unknown machine "${body.machine}"` }, 404)
    }

    return withSessionLock(sessionId, async () => {
      const runtime = new SessionRuntime(sessionId, config.store)
      try {
        // Hydrate route reads + origin machine. Subscribers and transitively
        // reachable machines come along via loadGraph's traversal.
        await runtime.loadGraph([...routeEntry.route.reads, originDef])
        runtime.wireSubscriptions()

        // Pre-event render: populates a RenderState with `lastValue`
        // snapshots that recompute will diff against once the event is
        // applied. The HTML output is discarded — POST returns patches.
        const { renderState } = renderRoute(
          routeEntry.route,
          routeKey,
          sessionId,
          runtime,
        )

        const touched = runtime.processEvent(body.machine, body.event)

        const patches = []
        for (const name of touched) {
          patches.push(...recompute(renderState, name, runtime))
        }

        await runtime.persistTouched(touched)
        return c.json({ patches })
      } finally {
        runtime.dispose()
      }
    })
  })

  return app
}

let cachedClientJs: string | null = null

async function bundleClient(): Promise<string> {
  if (cachedClientJs) return cachedClientJs
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = resolve(here, '../client/runtime.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    minify: false,
    logLevel: 'silent',
  })
  cachedClientJs = result.outputFiles[0]!.text
  return cachedClientJs
}

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}
