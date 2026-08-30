import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { applyRenderedEffects, runApiRoute } from './api-route.ts'
import { crossSiteGuard } from './csrf.ts'
import { scheduleSessionEffects } from './effects.ts'
import { record, replayFor } from './event-dedupe.ts'
import { type ImagesRenderInfo, type ResolvedImagesConfig, serveImage } from './images.ts'
import { buildInspectPayload } from './inspect.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import type { MiddlewareDefinition } from './middleware.ts'
import { runQueryRoute } from './query-route.ts'
import { initialSyncPatches, recompute } from './recompute.ts'
import { renderRoute } from './render.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { buildRouteRequest } from './route-request.ts'
import { isStatorQueryRoute, type RouteDefinition } from './routing.ts'
import {
  CLAIMS_KEY,
  getOrCreateSessionId,
  getSessionState,
  peekSessionId,
  resumeSession,
  sessionUse,
} from './session.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut, registerConnection, unregisterConnection } from './sse.ts'

const httpLog = scopedLogger('http')

export interface HttpConfig {
  routes: DiscoveredRoute[]
  store: MachineStore
  staticDir?: string
  /** Resolved image-serving config — present mounts the endpoint at
   *  `images.path` (see server/images.ts). */
  images?: ResolvedImagesConfig
  /** Optional hook to inject extra `<head>` HTML for a GET route, keyed by the
   *  route's file path. The dev server uses this to inline collected scoped CSS
   *  (SSR head injection). Inserted at the `</head>` boundary. */
  headExtras?: (filePath: string) => string | Promise<string>
  /** Serve the dev inspector asset at `/@stator/inspector.js`. The dev server
   *  sets this and injects the script tag; production leaves it off. */
  inspector?: boolean
  /** Serve the state-inspection endpoint at `/@stator/inspect` — the caller's
   *  own session's machine snapshots plus the machine/route catalog. Only the
   *  dev servers set this; production never does (machine context is working
   *  state and may hold anything), even when it opts into the wire toolbar. */
  inspect?: boolean
  /** SSE heartbeat interval in ms (default 25s). Tests shorten it. */
  ssePingMs?: number
  /** Origins allowed to make cross-site writes despite the guard (exact or
   *  wildcard-subdomain). Feeds the default `crossSiteGuard`. */
  trustedOrigins?: readonly string[]
  /** Session cookie `SameSite`. `Strict` flips the guard to allowlist-only for
   *  same-site writes too. */
  sameSite?: 'Lax' | 'Strict'
  /** Canonical app origin, exposed to middleware via `stator(c).origin`. */
  origin?: string
  /** Signed-cookie signing key (`config.secret` ?? `STATOR_SECRET`). Stashed on
   *  the request context so `cookies.setSigned`/`getSigned` can reach it. */
  secret?: string
  /** Build identifier — per-boot in dev, per-build in prod. Emitted into live
   *  pages as `<meta name="stator-build">`; the client echoes it on /__sse
   *  connect, and a mismatch reloads the page (its slot map may be stale). */
  buildId?: string
  /** Resolved CORS read policy, exposed via `stator(c).cors`. */
  cors?: { origins: readonly string[]; credentials: boolean }
  /** The app's discovered `middleware.ts` definition (if any). `withDefaults`
   *  controls whether the framework security stack is prepended. */
  middleware?: MiddlewareDefinition
  /** Layer-3 derived Cache-Control: emitted on GET responses the framework can
   *  PROVE anonymous-identical (no session reads declared, no session use or
   *  claims read while handling, nothing hand-set). Absent → never emitted
   *  (the dev servers leave it off so editing always re-renders). */
  caching?: { sMaxAge: number; staleWhileRevalidate: number }
}

/** Placeholder sid for session-free page renders — `loadGraph` loads only
 *  session-lifecycle machines, so on app-only routes this never reaches the
 *  store; it exists to keep SessionRuntime's signature honest. */
const ANONYMOUS_SID = '@anonymous'

const eventSchema = z.object({
  machine: z.string(),
  event: z
    .object({
      type: z.string(),
    })
    .passthrough(),
  /** Client-generated idempotency key — see server/event-dedupe.ts. */
  eventId: z.string().min(1).max(128).optional(),
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
      // A param may carry a literal suffix (`:id.json`): the capture stops
      // before the suffix, lazily, so `/p/a.b.json` yields id `a.b`.
      const dot = seg.indexOf('.')
      if (dot === -1) {
        pattern += '([^/]+)'
      } else {
        pattern += `([^/]+?)${seg.slice(dot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      }
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
function parseRouteKey(
  routeKey: string,
): { method: string; path: string; query: Record<string, string | undefined> } | null {
  const space = routeKey.indexOf(' ')
  if (space < 0) return null
  const target = routeKey.slice(space + 1)
  // The page's ?query travels IN the route key — a baseline re-render for a
  // query-dependent page (facets, pagination) must see the same request the
  // GET did, or its diffs describe a page the browser isn't showing.
  const q = target.indexOf('?')
  const path = q === -1 ? target : target.slice(0, q)
  const query: Record<string, string | undefined> = {}
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(target.slice(q + 1))) query[k] = v
  }
  return { method: routeKey.slice(0, space), path, query }
}

export async function buildHonoApp(config: HttpConfig): Promise<Hono> {
  const app = new Hono()
  // Render-side view of the images config: `<Image>`/`<Picture>` read this
  // from the render state so their URLs can't drift from the endpoint.
  const imagesInfo = config.images
    ? { widths: config.images.widths, aspectRatios: config.images.aspectRatios }
    : undefined
  const clientJs = await bundleClient()

  // Request logger: one line per request with method, path, status, duration.
  // SSE endpoints stay open indefinitely; we log on entry, not on close.
  app.use('*', async (c, next) => {
    const start = performance.now()
    await next()
    const ms = Math.round(performance.now() - start)
    const status = c.res.status
    const isLive = c.req.path === '/__sse'
    // Successful requests log at debug (one line per asset is prod noise); 4xx
    // warns and 5xx errors stay visible at the default level.
    httpLog[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug'](
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

  // Context bridge — expose resolved config to every middleware (cors, app
  // middleware) that follows, off `stator(c)`. Runs first. Sessions are LAZY
  // (the cacheable-read-path layer 1): an arriving cookie RESUMES its session
  // (claims eager-loaded, no cookie write), but first contact establishes
  // nothing — creation happens only at a dispatch, a session-machine read, an
  // SSE connect, or an explicit session op. Anonymous reads therefore carry
  // no Set-Cookie and stay CDN-cacheable. Dirty claims persist at the end,
  // to the current (possibly rotated or just-established) sid.
  app.use('*', async (c, next) => {
    c.set('stator', {
      origin: config.origin,
      trustedOrigins: config.trustedOrigins ?? [],
      sameSite: config.sameSite ?? 'Lax',
      cors: config.cors,
    })
    // Stash the store so middleware session ops (rotate/clear) can act now.
    c.set('statorStore', config.store)
    // Stash the signing key so the cookie jar's signed methods can reach it.
    if (config.secret !== undefined) c.set('statorSecret', config.secret)
    sessionUse(c)
    const resumed = resumeSession(c)
    if (resumed) {
      resumed.claims = (await config.store.persistence.get(resumed.sid, CLAIMS_KEY)) ?? undefined
    }
    await next()
    // Re-read: the session may have been established mid-request. Rotation
    // mutates `.sid` in place, so this persists to the current id.
    const session = getSessionState(c)
    if (session?.claimsDirty) {
      await config.store.persistence.set(session.sid, CLAIMS_KEY, session.claims, {
        ttlSeconds: config.store.sessionTtlSeconds,
      })
    }
  })

  // Security defaults (unless the app opted out via dangerouslyDefineMiddleware),
  // then the app's own middleware — all ahead of route matching, so a guard here
  // can't be missed by a route added later. crossSiteGuard runs before matching,
  // so a cross-site write to an unknown path 403s (not a route-revealing 404).
  const mw = config.middleware
  if (mw?.withDefaults ?? true) {
    app.use(
      '*',
      crossSiteGuard({
        trustedOrigins: config.trustedOrigins,
        strict: config.sameSite === 'Strict',
      }),
    )
  }
  for (const handler of mw?.handlers ?? []) {
    app.use('*', handler)
  }

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

  // Dev state inspection — cookie-scoped to the caller's own session (the
  // request bridge above established it). See server/inspect.ts for the
  // privacy stance; the flag is dev-server-only by construction.
  if (config.inspect) {
    app.get('/@stator/inspect', async (c) => {
      const payload = await buildInspectPayload({
        store: config.store,
        routes: config.routes,
        // Inspecting IS session use — the route shows the caller's own
        // session, so establish one for a first-contact dev visit.
        sessionId: getOrCreateSessionId(c).sessionId,
        buildId: config.buildId,
      })
      c.header('Cache-Control', 'no-cache')
      return c.json(payload)
    })
  }

  if (config.staticDir) {
    const staticDir = resolve(config.staticDir)
    app.get('/static/*', async (c) => {
      const rel = c.req.path.replace(/^\/static\//, '')
      // Containment check: resolve, then require the result to stay under
      // staticDir. This defeats `..` traversal AND absolute-path escapes —
      // `/static//etc/passwd` yields rel `/etc/passwd`, which `resolve` would
      // otherwise honor verbatim (discarding staticDir) and serve. A lexical
      // `..` check alone misses the absolute-path case.
      const full = resolve(staticDir, rel)
      if (full !== staticDir && !full.startsWith(staticDir + sep)) {
        return c.text('forbidden', 403)
      }
      try {
        const st = await stat(full)
        if (!st.isFile()) return c.text('not found', 404)

        // Caching contract: `/static/assets/*` is the framework's hashed-output
        // namespace (island bundles, emitted URL assets) — content-addressed by
        // construction, so a year of `immutable` is correct. Everything else
        // under `/static/` is user files with stable names: always revalidate,
        // but revalidation is a bodyless 304 (ETag from size+mtime, plus
        // Last-Modified for validators that only speak dates).
        const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
        c.header(
          'Cache-Control',
          rel.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
        )
        c.header('ETag', etag)
        c.header('Last-Modified', st.mtime.toUTCString())

        const inm = c.req.header('if-none-match')
        if (inm) {
          if (inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
            return c.body(null, 304)
          }
        } else {
          const ims = Date.parse(c.req.header('if-modified-since') ?? '')
          // HTTP dates have second precision; compare mtime truncated to match.
          if (!Number.isNaN(ims) && Math.trunc(st.mtimeMs / 1000) * 1000 <= ims) {
            return c.body(null, 304)
          }
        }

        const buf = await readFile(full)
        c.header('Content-Type', contentTypeFor(rel))
        return c.body(buf)
      } catch {
        return c.text('not found', 404)
      }
    })
  }

  if (config.images) {
    const images = config.images
    app.get(`${images.path}/*`, (c) => {
      let rel: string
      try {
        rel = decodeURIComponent(c.req.path.slice(images.path.length + 1))
      } catch {
        return c.text('not found', 404) // malformed percent-encoding is a 404, not a 500
      }
      return serveImage(
        images,
        rel,
        c.req.query('w'),
        c.req.query('h'),
        c.req.header('if-none-match') ?? null,
      )
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
    if (isStatorQueryRoute(route)) {
      return c.text(`route "${routeKey}" is a data route — data routes are not live`, 400)
    }
    if (!route.live) {
      return c.text(`route "${routeKey}" is not declared live: true`, 400)
    }
    // The SSE endpoint's own Request becomes the connection's request
    // object for fan-out renders. params come from the matched literal path;
    // the page's ?query rides in the route key.
    const request = {
      ...buildRouteRequest(c, matched.route.paramNames),
      params: matched.params,
      query: parsed.query,
    }

    const { sessionId } = getOrCreateSessionId(c)

    // Tell intermediate proxies (Fly edge, nginx, others) not to buffer the
    // response. Without this, small SSE messages can accumulate in a proxy
    // buffer waiting for a fill threshold, producing batched / dropped-
    // looking delivery on the client.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      // Build-id handshake: this page was rendered against a server build
      // (`build` param, from its `stator-build` meta). If ours differs — a dev
      // restart or a deploy since page load — its DOM↔slot-ID map may be stale,
      // so reload to fetch a fresh page instead of resyncing onto it. Checked
      // before any render/registration: a doomed connection does no work.
      const pageBuild = c.req.query('build')
      if (config.buildId && pageBuild && pageBuild !== config.buildId) {
        await stream.writeSSE({ data: JSON.stringify({ directives: [{ type: 'reload' }] }) })
        return
      }

      const runtime = new SessionRuntime(sessionId, config.store)
      await runtime.loadGraph(route.reads)
      const { renderState } = await renderRoute(route, routeKey, sessionId, runtime, request, {
        images: imagesInfo,
      })
      const conn = registerConnection({
        sessionId,
        clientId: c.req.query('client'),
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

      // Heartbeat every 25s. This is a real DATA message, not a comment, on
      // purpose: SSE comments keep proxies from reaping the connection but
      // are invisible to the browser's EventSource API — a client can't
      // detect a half-open zombie (device sleep, silent NAT drop: no FIN
      // ever arrives, no error fires) unless liveness is OBSERVABLE. The
      // runtime tracks last-message time and reconnects when pings stop.
      const keepAlive = setInterval(() => {
        void conn.send('{"ping":true}').catch(() => {
          // Stream closed; the abort handler cleans up.
        })
      }, config.ssePingMs ?? 25_000)

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
    // A data route serves no HTML, so no page runtime ever posts under its
    // key — a request that does is malformed or hand-crafted.
    if (isStatorQueryRoute(route)) {
      return c.json({ error: `route key "${routeKey}" targets a data route` }, 404)
    }
    const request = {
      ...buildRouteRequest(c, matched.route.paramNames),
      params: matched.params,
      query: parsed.query,
    }

    let body: z.infer<typeof eventSchema>
    try {
      body = eventSchema.parse(await c.req.json())
    } catch (e) {
      return c.json({ error: 'invalid event payload', detail: String(e) }, 400)
    }

    // The `@` event-name prefix is RESERVED for the framework. Nothing uses
    // it today (2.0 removed the engine's `@set`), and keeping the wire fence
    // means any future internal event is unreachable from untrusted input by
    // construction — a clean 400 at the boundary rather than a silent no-op.
    // History: `@set` (two-way bind:'s desugaring) was once wire-reachable —
    // a guard-bypassing arbitrary-context write, fixed as a security patch.
    if (body.event.type.startsWith('@')) {
      return c.json({ error: `event type "${body.event.type}" is reserved` }, 400)
    }

    const originDef = config.store.getDef(body.machine)
    if (!originDef) {
      return c.json({ error: `unknown machine "${body.machine}"` }, 404)
    }

    // `serverOnly` events are server-generated — effect completions
    // (`CHARGE_APPROVED`), `after:` timers, cross-machine internals — that no
    // client legitimately sends. A client POST of one is forgery (e.g. faking a
    // settled charge), so reject at the wire boundary with 403. The chart still
    // handles the event when the engine/effects raise it internally: that path
    // is `runtime.processEvent`, never `/__events`, so it's untouched. Enforced
    // in dev and prod alike — the declaration is explicit, so there's no
    // false-positive risk and no dev/prod divergence. Origin legitimacy only,
    // not per-user authorization — guards still own that.
    if (originDef.serverOnly.includes(body.event.type)) {
      return c.json({ error: `event type "${body.event.type}" is server-only` }, 403)
    }

    return withSessionLock(sessionId, async () => {
      // Idempotent replay: a duplicate POST (client retry after a lost
      // response) returns the original response body verbatim instead of
      // re-applying — keyed-list patches are positional, not idempotent.
      // Checked under the session lock so a retry racing its first attempt
      // queues behind it and always sees the recorded body.
      if (body.eventId) {
        const cached = replayFor(sessionId, body.eventId)
        if (cached !== undefined) {
          return c.body(cached, 200, { 'Content-Type': 'application/json' })
        }
      }
      const runtime = new SessionRuntime(sessionId, config.store)
      try {
        await runtime.loadGraph([...route.reads, originDef])
        runtime.wireSubscriptions()

        // Baseline render for the diff runs UNDER the session lock — never
        // resolve defer slots here (that would kick their I/O under the lock).
        const { renderState } = await renderRoute(route, routeKey, sessionId, runtime, request, {
          resolveDeferred: false,
          images: imagesInfo,
        })

        const touched = runtime.processEvent(body.machine, body.event)

        // Reads-aware selectors: bindings of machines whose selectors READ a
        // touched machine must re-diff too. Persistence stays direct-only —
        // derived machines' own state didn't move.
        const { all: recomputeSet } = config.store.expandTouchedForRecompute(touched)
        const patches = []
        for (const name of recomputeSet) {
          patches.push(...recompute(renderState, name, runtime))
        }

        // Persist committed machines plus any fresh machine that fired its
        // initial entry effect (an entry commits no transition, so it's not in
        // `touched`) — so it isn't re-created and re-fired next request.
        await runtime.persistTouched(new Set([...touched, ...runtime.entryFiredMachines()]))

        await fanOut(touched, {
          sessionId,
          originClientId: c.req.header('X-Stator-Client'),
        })

        // Fire-and-forget: the effects' I/O runs after this callback returns
        // (the lock is never held across it); completions re-enter via the
        // normal event path in server/effects.ts.
        scheduleSessionEffects(runtime, config.store, sessionId)

        const envelope = { patches, directives: [], committed: touched.size > 0 }
        if (body.eventId) record(sessionId, body.eventId, JSON.stringify(envelope))
        return c.json(envelope)
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
    const getRoute = matched.route.GET
    // Brand decides the GET plane: data routes never touch the HTML path
    // (no client-runtime injection, no live meta — a raw Response out).
    if (isStatorQueryRoute(getRoute)) {
      return runQueryRoute(c, matched.route, getRoute, config.store, matched.params, config.caching)
    }
    return handleGet(
      c,
      matched.route,
      getRoute,
      matched.params,
      config.store,
      config.headExtras,
      config.buildId,
      imagesInfo,
      config.caching,
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
    // The inspector imports its CSS as a text string (bundled inline, no
    // separate stylesheet request).
    loader: { '.css': 'text' },
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
  buildId?: string,
  images?: ImagesRenderInfo,
  caching?: { sMaxAge: number; staleWhileRevalidate: number },
): Promise<Response> {
  {
    // Lazy layer 1: only a session-machine read forces establishment. An
    // app-only (or read-free) page renders against the resumed sid when a
    // cookie arrived, or an inert placeholder — loadGraph loads session
    // machines only, so the placeholder never reaches the store.
    const needsSession = route.reads.some((def) => def.lifecycle === 'session')
    const sessionId = needsSession
      ? getOrCreateSessionId(c).sessionId
      : (peekSessionId(c) ?? ANONYMOUS_SID)
    const literalPath = c.req.path
    const routeKey = `GET ${literalPath}`
    const request = { ...buildRouteRequest(c, discovered.paramNames), params }

    const runtime = new SessionRuntime(sessionId, store)
    try {
      await runtime.loadGraph(route.reads)
      const result = await renderRoute(route, routeKey, sessionId, runtime, request, { images })
      let html = result.html

      const headHtml: string[] = []
      if (headExtras) {
        const extra = await headExtras(discovered.filePath)
        if (extra) headHtml.push(extra)
      }
      if (route.live) {
        headHtml.push('<meta name="stator-live" content="true">')
        // The build this page was rendered against — the client echoes it on
        // /__sse connect so the server can reload a page from a stale build.
        // `buildId` is a framework-generated UUID (no HTML-special chars).
        if (buildId) {
          headHtml.push(`<meta name="stator-build" content="${buildId}">`)
        }
      }

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

      // A fresh machine that fired its initial entry effect on load must be
      // persisted (so the next request hydrates instead of re-firing) and its
      // effect scheduled off-lock, after the response. The common GET (no entry
      // effect) skips both and stays a pure read.
      const entryFired = runtime.entryFiredMachines()
      if (entryFired.size > 0) {
        await runtime.persistTouched(entryFired)
        scheduleSessionEffects(runtime, store, sessionId)
      }

      // Layer 3 — derived Cache-Control: the page is PROVABLY anonymous-
      // identical (no session reads declared, no session use or claims read
      // during handling) and the route didn't hand-set the header. The
      // framework says what it can prove; hand-set always wins.
      const use = sessionUse(c)
      if (
        caching &&
        !needsSession &&
        !use.used &&
        !use.claimsRead &&
        result.response.status < 300 &&
        result.response.cookies.length === 0 &&
        !result.response.headers.has('cache-control')
      ) {
        c.header(
          'Cache-Control',
          `public, s-maxage=${caching.sMaxAge}, stale-while-revalidate=${caching.staleWhileRevalidate}`,
        )
      }

      return c.html(html)
    } finally {
      runtime.dispose()
    }
  }
}

export function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.ico') return 'image/x-icon'
  if (ext === '.wasm') return 'application/wasm'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.ttf') return 'font/ttf'
  if (ext === '.otf') return 'font/otf'
  return 'application/octet-stream'
}
