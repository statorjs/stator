import { relative } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'
import { scopedLogger } from './logger.ts'
import type { DiscoveredRoute } from './route-discovery.ts'

/** Exported for tests, which watch its `warn`. */
export const limitLog = scopedLogger('http')

/** The 4.0 default, and the size past which 3.x warns when no limit is set. */
export const WARN_BODY_BYTES = 1024 * 1024

/**
 * The error a body read rejects with once the request passes its
 * `maxBodyBytes` limit. The framework answers the request with a 413 whatever
 * the handler does with the rejection, so most handlers can let it throw.
 */
export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError'
  /** The limit the body passed, in bytes. */
  readonly limit: number
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`)
    this.limit = limit
  }
}

/** Requests whose counted body passed its limit. Keyed by the request the
 *  framework handed the route, so `runApiRoute` can recognise the failed read
 *  however the handler surfaced it. */
const overLimit = new WeakSet<Request>()

/** True once this request's body has been counted past its limit. */
export function bodyOverLimit(c: Context): boolean {
  return overLimit.has(c.req.raw)
}

/** Throw at definition or boot time on a limit that is not a positive number
 *  of bytes. `Infinity` is a number and means "no limit". */
export function assertBodyLimit(value: unknown, field: string): void {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new Error(
      `stator: ${field} must be a positive number of bytes (Infinity for no limit) — got ${String(value)}.`,
    )
  }
}

type Resolved =
  | { limit: number; source: string; route: DiscoveredRoute | undefined }
  | { limit: undefined; route: DiscoveredRoute | undefined }

export interface BodyLimitOptions {
  /** The route matched for a path, the same lookup command dispatch uses. */
  match: (path: string) => DiscoveredRoute | undefined
  /** `requests.maxBodyBytes`, when the project set it. */
  maxBodyBytes?: number
}

/**
 * Framework plumbing that caps request bodies outside `/__events`. A declared
 * `Content-Length` over the limit is refused before anything downstream runs;
 * otherwise the body is replaced by a counting stream, and a read that passes
 * the limit errors with `BodyTooLargeError` and turns the response into a 413.
 * Nothing is buffered: the body is still read only when, and as far as, the
 * handler reads it.
 */
export function bodyLimit(opts: BodyLimitOptions): MiddlewareHandler {
  if (opts.maxBodyBytes !== undefined) assertBodyLimit(opts.maxBodyBytes, 'requests.maxBodyBytes')
  // Routes (method + pattern, or the path when nothing matched) already
  // warned about in this process.
  const warned = new Set<string>()

  const resolve = (method: string, path: string): Resolved => {
    const route = opts.match(path)
    const def =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? route?.[method]
        : undefined
    if (def?.maxBodyBytes !== undefined) {
      return { limit: def.maxBodyBytes, source: routeSource(route!, method), route }
    }
    if (opts.maxBodyBytes !== undefined) {
      return { limit: opts.maxBodyBytes, source: 'requests.maxBodyBytes', route }
    }
    return { limit: undefined, route }
  }

  return async (c, next) => {
    const method = c.req.method
    const raw = c.req.raw
    if (method === 'GET' || method === 'HEAD') return next()
    if (method === 'POST' && c.req.path === '/__events') return next()
    if (raw.body === null) return next()

    const resolved = resolve(method, c.req.path)
    const { limit } = resolved
    if (limit === Infinity) return next()

    if (limit !== undefined) {
      const declared = Number(raw.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > limit) {
        logRefusal(method, c.req.path, limit, resolved.source)
        return tooLarge(limit)
      }
    }

    let count = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength
        if (limit !== undefined && count > limit) {
          overLimit.add(counted)
          controller.error(new BodyTooLargeError(limit))
          return
        }
        controller.enqueue(chunk)
      },
      flush() {
        if (limit !== undefined || count <= WARN_BODY_BYTES) return
        const key = resolved.route
          ? `${method} ${resolved.route.urlPath}`
          : `${method} ${c.req.path}`
        if (warned.has(key)) return
        warned.add(key)
        limitLog.warn(
          { method, path: c.req.path, bytes: count },
          `stator: ${method} ${c.req.path} received a ${count}-byte body and no limit is set. ` +
            `4.0 will refuse bodies over ${WARN_BODY_BYTES} bytes by default. Set maxBodyBytes on ` +
            `this route's defineApiRoute, or requests.maxBodyBytes in stator.config.ts.`,
        )
      },
    })
    // Replace the request the way Hono's own middleware does: everything
    // downstream (route handlers through `RouteRequest`, `c.req.*` in app
    // middleware) reads `c.req.raw`, so every reader reads the counted body.
    const counted = new Request(raw, {
      body: raw.body.pipeThrough(counter),
      duplex: 'half',
    } as RequestInit)
    c.req.raw = counted

    await next()

    if (limit !== undefined && overLimit.has(counted)) {
      logRefusal(method, c.req.path, limit, resolved.source)
      // Drop the response the handler built first: assigning over it would
      // carry its headers and cookies onto the 413. The 413 is built without
      // the context too, which holds any header set before a response existed.
      c.res = undefined
      c.res = tooLarge(limit)
    }
  }
}

function tooLarge(limit: number): Response {
  return Response.json({ error: `request body exceeds ${limit} bytes` }, { status: 413 })
}

function logRefusal(method: string, path: string, limit: number, source: string): void {
  limitLog.warn(
    { method, path, limit },
    `stator: ${method} ${path} refused: body exceeds ${limit} bytes (${source}). Raise it ` +
      `in stator.config.ts, or set maxBodyBytes on this route's defineApiRoute.`,
  )
}

/** Where a route-level limit came from, for the log line. A URL can merge a
 *  page template (GET) with a command file, and discovery keeps one
 *  `filePath`; a template is never the file that holds the command. */
function routeSource(route: DiscoveredRoute, method: string): string {
  const file = route.filePath
  if (file.endsWith('.stator')) return `maxBodyBytes on this route's ${method} defineApiRoute`
  const rel = relative(process.cwd(), file)
  return `maxBodyBytes on ${rel.startsWith('..') ? file : rel}`
}
