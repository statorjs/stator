import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { isResponseLike } from './api-route.ts'
import { scheduleSessionEffects } from './effects.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { buildRouteRequest } from './route-request.ts'
import type {
  QueryRouteDefinition,
  QueryRouteHelpers,
  QueryRouteResult,
  RouteContext,
} from './routing.ts'
import { getOrCreateSessionId, peekSessionId, sessionUse } from './session.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'

const queryLog = scopedLogger('query')

/** Default Content-Type by URL extension for data GET responses. The URL —
 *  not the file on disk — carries the extension (`rss.xml.ts` serves
 *  `/rss.xml`), so inference reads the request path. */
const DATA_CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atom': 'application/atom+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

/** Second-level file extensions (`feed.xml.ts`) that mark a route file as
 *  unambiguously a data route — discovery hard-errors on malformed exports
 *  in one instead of skipping it as a utility. `.stator.ts` keeps its own,
 *  different second-level meaning and is not in this set. */
export const dataFileExtensions: ReadonlySet<string> = new Set(
  Object.keys(DATA_CONTENT_TYPES).map((e) => e.slice(1)),
)

/**
 * Run a data GET route: hydrate the reads graph, run the read-only handler,
 * synthesize the response.
 *
 * Lock discipline: hydration happens under the session lock so the snapshot
 * is coherent ACROSS machines (no half-committed view of a concurrent POST),
 * and the lock is released before the handler runs — the handler cannot
 * dispatch, so there is nothing to interleave with, and handler I/O never
 * holds the lock.
 */
export async function runQueryRoute(
  c: Context,
  discovered: DiscoveredRoute,
  route: QueryRouteDefinition,
  store: MachineStore,
  /** Path params from the framework's own matcher (the GET catch-all
   *  bypasses Hono's per-route param extraction). */
  params?: Record<string, string>,
  /** Layer-3 derived Cache-Control values (absent → never emitted). */
  caching?: { sMaxAge: number; staleWhileRevalidate: number },
): Promise<Response> {
  // Lazy layer 1: only session-machine reads establish; an app-only data
  // route (a feed, a sitemap) renders sessionless and stays CDN-cacheable.
  const needsSession = route.reads.some((def) => def.lifecycle === 'session')
  const sessionId = needsSession
    ? getOrCreateSessionId(c).sessionId
    : (peekSessionId(c) ?? '@anonymous')
  const request = params
    ? { ...buildRouteRequest(c, discovered.paramNames), params }
    : buildRouteRequest(c, discovered.paramNames)

  const runtime = new SessionRuntime(sessionId, store)
  try {
    await withSessionLock(sessionId, () => runtime.loadGraph(route.reads))

    // Same shape as a page's render context: proxies keyed by machine name.
    // Session machines come from the hydrated runtime, app machines resolve
    // through the long-lived app-instance fallback.
    const machines: RouteContext = {}
    for (const def of route.reads) {
      const proxy = runtime.proxyFor(def.name)
      if (!proxy) {
        throw new Error(`stator: route reads "${def.name}" but it's not loaded into the runtime`)
      }
      machines[def.name] = proxy
    }

    let result: QueryRouteResult
    try {
      // The map is built dynamically by machine name; the typed ReadsMap
      // guarantee is for the user's handler, recovered at their call site.
      result = await route.handler(request, {
        machines: machines as QueryRouteHelpers['machines'],
      })
    } catch (err) {
      queryLog.error({ err: String(err), path: c.req.path }, 'data route handler threw')
      return c.text('Internal Server Error', 500)
    }

    // A fresh machine whose hydrate fired a load entry effect: persist so the
    // next request restores instead of re-firing, and schedule the effect
    // off-lock. The common query is a pure read and skips both (mirrors GET
    // page handling).
    const entryFired = runtime.entryFiredMachines()
    if (entryFired.size > 0) {
      await runtime.persistTouched(entryFired)
      scheduleSessionEffects(runtime, store, sessionId)
    }

    const res = synthesizeDataResponse(c, result)
    // Layer 3 — derived Cache-Control, same proof as pages: no session reads
    // declared, no session use/claims read while handling, handler set
    // nothing itself. Applied to 200 and 304 alike (a 304's headers update
    // the cached entry's lifetime).
    const use = sessionUse(c)
    if (
      caching &&
      !needsSession &&
      !use.used &&
      !use.claimsRead &&
      res.status < 400 &&
      !res.headers.has('cache-control')
    ) {
      try {
        res.headers.set(
          'cache-control',
          `public, max-age=0, s-maxage=${caching.sMaxAge}, stale-while-revalidate=${caching.staleWhileRevalidate}`,
        )
      } catch {
        // Immutable headers (proxied Response) — the handler's call.
      }
    }
    return res
  } finally {
    runtime.dispose()
  }
}

/** The URL's extension (`/rss.xml` → `.xml`). A leading dot alone
 *  (`/.well-known`) is not an extension. */
function urlExtension(path: string): string | undefined {
  const last = path.slice(path.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot).toLowerCase() : undefined
}

/**
 * Response synthesis for data GET results:
 *   - Response-like → passthrough, Content-Type filled from the URL extension
 *     only when the handler set none.
 *   - string → body as-is, Content-Type from the URL extension
 *     (`text/plain` fallback).
 *   - anything else → JSON, always — a plain value is data, whatever the URL
 *     looks like.
 *
 * Synthesized responses carry a strong body-hash ETag and answer
 * `If-None-Match` with 304, so polling consumers stop paying for unchanged
 * bodies. (The designed upgrade — 304 from the machine-revision ledger
 * WITHOUT invoking the handler — rides the same header contract.)
 */
function synthesizeDataResponse(c: Context, result: QueryRouteResult): Response {
  const ext = urlExtension(c.req.path)
  const inferred = ext ? DATA_CONTENT_TYPES[ext] : undefined

  if (isResponseLike(result)) {
    if (inferred && !result.headers.get('content-type')) {
      try {
        result.headers.set('content-type', inferred)
      } catch {
        // Immutable headers (e.g. a proxied response) — the handler's call.
      }
    }
    return result
  }

  const isString = typeof result === 'string'
  const body = isString ? result : (JSON.stringify(result) ?? 'null')
  const contentType = isString
    ? (inferred ?? 'text/plain; charset=utf-8')
    : 'application/json; charset=utf-8'

  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
  if ((c.req.header('if-none-match') ?? '').includes(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  return new Response(body, { headers: { 'Content-Type': contentType, ETag: etag } })
}
