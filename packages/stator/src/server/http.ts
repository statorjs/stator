import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import type { MachineStore } from './machine-store.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { HTTP_METHODS } from './route-discovery.ts'
import { renderRoute } from './render.ts'
import { recompute } from './recompute.ts'
import { getOrCreateSessionId } from './session.ts'
import { SessionRuntime } from './session-runtime.ts'
import type { RouteDefinition } from './routing.ts'
import { fanOut, registerConnection, unregisterConnection } from './sse.ts'
import { scopedLogger } from './logger.ts'
import { buildRouteRequest } from './route-request.ts'
import { runApiRoute, applyRenderedEffects } from './api-route.ts'

const httpLog = scopedLogger('http')

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

/** Compiled matcher: turns `/p/:id` into a regex that captures params. */
interface RouteMatcher {
  route: DiscoveredRoute
  regex: RegExp
}

function compileMatcher(route: DiscoveredRoute): RouteMatcher {
  // Translate Hono-pattern (`/p/:id`) into a regex that matches a literal
  // URL path and captures each param value.
  const pattern = route.urlPath
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '([^/]+)'
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { route, regex: new RegExp(`^${pattern}$`) }
}

/**
 * Match a literal URL path against compiled matchers. Returns the matched
 * route + extracted params, or null if nothing matches.
 */
function matchPath(
  matchers: RouteMatcher[],
  literalPath: string,
): { route: DiscoveredRoute; params: Record<string, string> } | null {
  for (const m of matchers) {
    const result = m.regex.exec(literalPath)
    if (!result) continue
    const params: Record<string, string> = {}
    m.route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(result[i + 1] ?? '')
    })
    return { route: m.route, params }
  }
  return null
}

/** Parse a route key like "GET /p/abc-123" into method + literal path. */
function parseRouteKey(routeKey: string): { method: string; path: string } | null {
  const space = routeKey.indexOf(' ')
  if (space < 0) return null
  return { method: routeKey.slice(0, space), path: routeKey.slice(space + 1) }
}

export async function buildHonoApp(config: HttpConfig): Promise<Hono> {
  const app = new Hono()
  const clientJs = await bundleClient()

  // Request logger: one line per request with method, path, status, duration.
  // SSE endpoints stay open indefinitely; we log on entry, not on close.
  app.use('*', async (c, next) => {
    const start = performance.now()
    await next()
    const ms = Math.round(performance.now() - start)
    const status = c.res.status
    const isLive = c.req.path === '/__sse'
    httpLog[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'](
      { method: c.req.method, path: c.req.path, status, ms, sse: isLive || undefined },
      isLive ? 'sse open' : 'request',
    )
  })

  // Compile matchers for GET routes. Used by POST /__events and SSE to
  // resolve a literal client path back to a route pattern + params.
  const getMatchers: RouteMatcher[] = config.routes
    .filter((r) => r.GET)
    .map(compileMatcher)

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
    if (route.GET) registerGetRoute(app, route, route.GET, config.store)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const apiRoute = route[method]
      if (!apiRoute) continue
      app.on(method, route.urlPath, async (c) => {
        return runApiRoute(c, route, apiRoute, config.store)
      })
    }
  }

  // SSE endpoint. The connection's runtime + renderState stay alive for
  // the connection's lifetime — this is the one place per-session state
  // outlives a request, because the connection *is* one (very long) request.
  app.get('/__sse', async (c) => {
    const routeKey = c.req.query('route')
    if (!routeKey) return c.text('missing route param', 400)
    const parsed = parseRouteKey(routeKey)
    if (!parsed || parsed.method !== 'GET') {
      return c.text(`malformed route key "${routeKey}"`, 400)
    }
    const matched = matchPath(getMatchers, parsed.path)
    if (!matched || !matched.route.GET) {
      return c.text(`unknown route "${routeKey}"`, 404)
    }
    const route = matched.route.GET
    if (!route.live) {
      return c.text(`route "${routeKey}" is not declared live: true`, 400)
    }
    // The SSE endpoint's own Request becomes the connection's request
    // object for fan-out renders. params come from the matched literal path.
    const request = {
      ...buildRouteRequest(c, matched.route.paramNames),
      params: matched.params,
    }

    const { sessionId } = getOrCreateSessionId(c)

    // Tell intermediate proxies (Fly edge, nginx, others) not to buffer the
    // response. Without this, small SSE messages can accumulate in a proxy
    // buffer waiting for a fill threshold, producing batched / dropped-
    // looking delivery on the client.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      const runtime = new SessionRuntime(sessionId, config.store)
      await runtime.loadGraph(route.reads)
      const { renderState } = renderRoute(
        route,
        routeKey,
        sessionId,
        runtime,
        request,
      )
      const conn = registerConnection({
        sessionId,
        routeKey,
        route,
        request,
        runtime,
        renderState,
        send: async (data: string) => {
          await stream.writeSSE({ data })
        },
      })

      // Force an immediate flush so edge proxies commit response headers
      // and consider the stream "alive" before any fan-out arrives.
      await stream.write(': open\n\n')

      // Keep-alive every 25s so proxy idle timeouts don't close the
      // connection between real events.
      const keepAlive = setInterval(() => {
        stream.write(': keep-alive\n\n').catch(() => {
          // Stream closed; will be cleaned up by abort handler.
        })
      }, 25_000)

      try {
        await new Promise<void>((resolveFn) => {
          stream.onAbort(() => resolveFn())
        })
      } finally {
        clearInterval(keepAlive)
        unregisterConnection(conn.id)
      }
    })
  })

  app.post('/__events', async (c) => {
    const { sessionId } = getOrCreateSessionId(c)
    const routeKey = c.req.header('X-Stator-Route')
    if (!routeKey) {
      return c.json({ error: 'missing X-Stator-Route header' }, 400)
    }
    const parsed = parseRouteKey(routeKey)
    if (!parsed || parsed.method !== 'GET') {
      return c.json({ error: `malformed route key "${routeKey}"` }, 400)
    }
    const matched = matchPath(getMatchers, parsed.path)
    if (!matched || !matched.route.GET) {
      return c.json({ error: `unknown route "${routeKey}"` }, 404)
    }
    const route = matched.route.GET
    const request = {
      ...buildRouteRequest(c, matched.route.paramNames),
      params: matched.params,
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
        await runtime.loadGraph([...route.reads, originDef])
        runtime.wireSubscriptions()

        const { renderState } = renderRoute(
          route,
          routeKey,
          sessionId,
          runtime,
          request,
        )

        const touched = runtime.processEvent(body.machine, body.event)

        const patches = []
        for (const name of touched) {
          patches.push(...recompute(renderState, name, runtime))
        }

        await runtime.persistTouched(touched)

        await fanOut(touched)

        return c.json({ patches, directives: [] })
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

function registerGetRoute(
  app: Hono,
  discovered: DiscoveredRoute,
  route: RouteDefinition,
  store: MachineStore,
): void {
  app.get(discovered.urlPath, async (c) => {
    const { sessionId } = getOrCreateSessionId(c)
    const literalPath = c.req.path
    const routeKey = `GET ${literalPath}`
    const request = buildRouteRequest(c, discovered.paramNames)

    const runtime = new SessionRuntime(sessionId, store)
    try {
      await runtime.loadGraph(route.reads)
      const result = renderRoute(route, routeKey, sessionId, runtime, request)
      let html = result.html
      if (route.live) {
        // TODO(V1): replace this string-replace with a sentinel-comment
        // insertion point (e.g. `<!--stator:head-->` in the layout). The
        // second thing the framework needs to inject into <head> (CSP nonce,
        // SSE base URL, hydration manifest, etc.) is when this pattern
        // becomes untenable — don't add a second .replace() here, build the
        // sentinel mechanism instead.
        html = html.replace(
          '</head>',
          '<meta name="stator-live" content="true"></head>',
        )
      }
      applyRenderedEffects(c, result.response)
      return c.html(html)
    } finally {
      runtime.dispose()
    }
  })
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
