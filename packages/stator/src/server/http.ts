import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { applyRenderedEffects, runApiRoute } from './api-route.ts'
import { scheduleSessionEffects } from './effects.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import { initialSyncPatches, recompute } from './recompute.ts'
import { renderRoute } from './render.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { buildRouteRequest } from './route-request.ts'
import type { RouteDefinition } from './routing.ts'
import { getOrCreateSessionId } from './session.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut, registerConnection, unregisterConnection } from './sse.ts'

const httpLog = scopedLogger('http')

export interface HttpConfig {
  routes: DiscoveredRoute[]
  store: MachineStore
  staticDir?: string
  /** Optional hook to inject extra `<head>` HTML for a GET route, keyed by the
   *  route's file path. The dev server uses this to inline collected scoped CSS
   *  (SSR head injection). Inserted at the `</head>` boundary. */
  headExtras?: (filePath: string) => string | Promise<string>
  /** Serve the dev inspector asset at `/@stator/inspector.js`. The dev server
   *  sets this and injects the script tag; production leaves it off. */
  inspector?: boolean
}

const eventSchema = z.object({
  machine: z.string(),
  event: z
    .object({
      type: z.string(),
    })
    .passthrough(),
})

/** Compiled matcher: turns `/p/:id` into a regex that captures params. */
interface RouteMatcher {
  route: DiscoveredRoute
  regex: RegExp
}

function compileMatcher(route: DiscoveredRoute): RouteMatcher {
  // Translate Hono-pattern (`/p/:id`) into a regex that matches a literal
  // URL path and captures each param value.
  // A rest segment (`*name`) consumes the remainder including its leading slash,
  // so it can match zero segments (`/files` for `/files/[...path]`).
  const parts = route.urlPath.split('/')
  let pattern = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!
    if (seg.startsWith('*')) {
      // Absorb the preceding `/` and match the (possibly empty) remainder.
      pattern = `${pattern.replace(/\/$/, '')}(?:/(.*))?`
    } else if (seg.startsWith(':')) {
      pattern += '([^/]+)'
      if (i < parts.length - 1) pattern += '/'
    } else {
      pattern += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (i < parts.length - 1) pattern += '/'
    }
  }
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
      {
        method: c.req.method,
        path: c.req.path,
        status,
        ms,
        sse: isLive || undefined,
      },
      isLive ? 'sse open' : 'request',
    )
  })

  // Compile matchers for every route, in discovery's specificity order. Our own
  // matcher (not Hono's router) is the routing authority: GET/API dispatch and
  // SSE/POST resolution all go through `matchPath`, so rest params (`*name`) and
  // specificity ordering behave identically everywhere. Hono only routes the
  // fixed framework endpoints (static exact paths it prioritizes over `*`).
  const matchers: RouteMatcher[] = config.routes.map(compileMatcher)
  const getMatchers = matchers // SSE/POST filter by `.GET` after matching

  app.get('/static/client.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    return c.body(clientJs)
  })

  // Dev inspector asset — served only when enabled (the dev server injects the
  // matching script tag). Bundled lazily on first build of the app.
  if (config.inspector) {
    const inspectorJs = await bundleInspector()
    app.get('/@stator/inspector.js', (c) => {
      c.header('Content-Type', 'application/javascript; charset=utf-8')
      c.header('Cache-Control', 'no-cache')
      return c.body(inspectorJs)
    })
  }

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

  // SSE endpoint. The connection's runtime + renderState stay alive for
  // the connection's lifetime — this is the one place per-session state
  // outlives a request, because the connection *is* one (very long) request.
  app.get('/__sse', async (c) => {
    const routeKey = c.req.query('route')
    if (!routeKey) return c.text('missing route param', 400)
    const parsed = parseRouteKey(routeKey)
    if (parsed?.method !== 'GET') {
      return c.text(`malformed route key "${routeKey}"`, 400)
    }
    const matched = matchPath(getMatchers, parsed.path)
    if (!matched?.route.GET) {
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
      const { renderState } = renderRoute(route, routeKey, sessionId, runtime, request)
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

      // Converge the page onto this connection's baseline: the DOM was
      // rendered at page-GET time, the baseline at connect time, and any
      // state change in between (an effect settling mid-navigation) would
      // otherwise never reach this page.
      const sync = initialSyncPatches(renderState, runtime)
      if (sync.length > 0) {
        await conn.send(JSON.stringify({ patches: sync }))
      }

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
    if (parsed?.method !== 'GET') {
      return c.json({ error: `malformed route key "${routeKey}"` }, 400)
    }
    const matched = matchPath(getMatchers, parsed.path)
    if (!matched?.route.GET) {
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

        const { renderState } = renderRoute(route, routeKey, sessionId, runtime, request)

        const touched = runtime.processEvent(body.machine, body.event)

        // Reads-aware selectors: bindings of machines whose selectors READ a
        // touched machine must re-diff too. Persistence stays direct-only —
        // derived machines' own state didn't move.
        const { all: recomputeSet } = config.store.expandTouchedForRecompute(touched)
        const patches = []
        for (const name of recomputeSet) {
          patches.push(...recompute(renderState, name, runtime))
        }

        await runtime.persistTouched(touched)

        await fanOut(touched, { sessionId })

        // Fire-and-forget: the effects' I/O runs after this callback returns
        // (the lock is never held across it); completions re-enter via the
        // normal event path in server/effects.ts.
        scheduleSessionEffects(runtime, config.store, sessionId)

        return c.json({ patches, directives: [], committed: touched.size > 0 })
      } finally {
        runtime.dispose()
      }
    })
  })

  // User-route dispatch: catch-alls resolved by our matcher, registered LAST so
  // the fixed framework endpoints (/__events, /__sse, /static/*) — all registered
  // above — take their requests first. A request that matches no user route falls
  // through to Hono's default (so framework paths handled above are untouched).
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.on(method, '*', async (c, next) => {
      const matched = matchPath(matchers, c.req.path)
      const apiRoute = matched?.route[method]
      if (!matched || !apiRoute) return next()
      return runApiRoute(c, matched.route, apiRoute, config.store, matched.params)
    })
  }

  app.get('*', async (c, next) => {
    const matched = matchPath(matchers, c.req.path)
    if (!matched?.route.GET) return next()
    return handleGet(
      c,
      matched.route,
      matched.route.GET,
      matched.params,
      config.store,
      config.headExtras,
    )
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

let cachedInspectorJs: string | null = null

async function bundleInspector(): Promise<string> {
  if (cachedInspectorJs) return cachedInspectorJs
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = resolve(here, '../client/inspector.ts')
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    minify: false,
    logLevel: 'silent',
  })
  cachedInspectorJs = result.outputFiles[0]!.text
  return cachedInspectorJs
}

/**
 * Insert framework HTML at the document's `<head>` and end-of-`<body>`
 * boundaries — each a no-op when its boundary is absent (e.g. a route that
 * renders a bare fragment, which can't host the runtime anyway). One
 * consolidated injector rather than stacked `.replace()` calls.
 */
function injectIntoDocument(html: string, parts: { head?: string; bodyEnd?: string }): string {
  let out = html
  if (parts.head && out.includes('</head>')) {
    out = out.replace('</head>', `${parts.head}</head>`)
  }
  if (parts.bodyEnd && out.includes('</body>')) {
    out = out.replace('</body>', `${parts.bodyEnd}</body>`)
  }
  return out
}

async function handleGet(
  c: Context,
  discovered: DiscoveredRoute,
  route: RouteDefinition,
  params: Record<string, string>,
  store: MachineStore,
  headExtras?: (filePath: string) => string | Promise<string>,
): Promise<Response> {
  {
    const { sessionId } = getOrCreateSessionId(c)
    const literalPath = c.req.path
    const routeKey = `GET ${literalPath}`
    const request = { ...buildRouteRequest(c, discovered.paramNames), params }

    const runtime = new SessionRuntime(sessionId, store)
    try {
      await runtime.loadGraph(route.reads)
      const result = renderRoute(route, routeKey, sessionId, runtime, request)
      let html = result.html

      const headHtml: string[] = []
      if (headExtras) {
        const extra = await headExtras(discovered.filePath)
        if (extra) headHtml.push(extra)
      }
      if (route.live) headHtml.push('<meta name="stator-live" content="true">')

      // Auto-inject the client runtime (delegated events + patch application).
      // Apps never hand-include it — a forgotten <script> is a silently dead
      // page (events fire nothing, no patches apply). Idempotent: skipped if the
      // document already references it, so a layout that still carries the tag
      // (or two passes sharing a doc) never loads it twice.
      const bodyHtml: string[] = []
      if (!html.includes('/static/client.js')) {
        bodyHtml.push('<script src="/static/client.js"></script>')
      }

      html = injectIntoDocument(html, {
        head: headHtml.join(''),
        bodyEnd: bodyHtml.join(''),
      })
      applyRenderedEffects(c, result.response)
      return c.html(html)
    } finally {
      runtime.dispose()
    }
  }
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
