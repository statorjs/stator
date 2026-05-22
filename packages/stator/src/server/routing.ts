import type { MachineDef } from './define-machine.ts'
import type { HtmlFragment } from '../template/types.ts'

/** Machine context passed to a route's render function. Keyed by machine name. */
export type RouteContext = Record<string, unknown>

/**
 * Request context for routes. Mostly delegates to the underlying `Request`
 * via `raw`, plus convenience fields for the bits that need parsing the
 * framework already does (path params, query strings).
 *
 * Same shape on `defineRoute` and `defineApiRoute`. GETs ignore body access,
 * API routes use it.
 */
export interface RouteRequest {
  /** The underlying Web Platform Request. Escape hatch for anything the
   *  wrapper doesn't expose directly. */
  raw: Request
  /** Path params extracted from `[name]` segments. Always strings. */
  params: Record<string, string>
  /** Query string params from the URL. Repeated keys collapse to the
   *  first value (Hono's default). */
  query: Record<string, string | undefined>
  /** HTTP method. Same as `raw.method`. */
  readonly method: string
  /** Full request URL. Same as `raw.url`. */
  readonly url: string
  /** Request headers. Same Headers instance as `raw.headers`. */
  readonly headers: Headers
  /** Parsed form body. Throws if the content type doesn't match. */
  formData(): Promise<FormData>
  /** Parsed JSON body. Throws on invalid JSON. */
  json<T = unknown>(): Promise<T>
  /** Raw text body. */
  text(): Promise<string>
  /** Raw binary body. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Options for `response.cookies.set`. */
export interface RouteCookieOptions {
  domain?: string
  path?: string
  expires?: Date
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/**
 * Response side-effect surface for `defineRoute` render functions. Pages
 * return their content (HtmlFragment) and influence response-level
 * concerns by mutating this object. The framework combines the rendered
 * HTML with whatever was set here to build the final HTTP response.
 *
 * `headers` is a real Web Platform `Headers` instance. `status` is a
 * settable property. `cookies` is a focused helper because the cookie
 * attribute model is enough of its own thing to deserve a dedicated API.
 */
export interface RouteResponseContext {
  /** HTTP status code. Default 200. */
  status: number
  /** Response headers. Mutable; standard Headers API. */
  readonly headers: Headers
  /** Cookie helpers. Distinct from headers because cookie attributes
   *  (HttpOnly, SameSite, etc.) deserve a focused API. */
  readonly cookies: {
    set(name: string, value: string, options?: RouteCookieOptions): void
    delete(name: string, options?: Pick<RouteCookieOptions, 'path' | 'domain'>): void
  }
}

/** Machine context for `defineRoute` includes the response side-effect
 *  surface alongside the machine proxies. */
export type RouteRenderContext = RouteContext & {
  /** Reserved key. User machines named `response` would collide; reserved
   *  in the discovery validator. */
  response: RouteResponseContext
}

export interface RouteDefinition {
  readonly __isStatorRoute: true
  reads: MachineDef<any, any>[]
  render: (ctx: RouteRenderContext, request: RouteRequest) => HtmlFragment
  /** When true, the rendered page opens an SSE channel that receives
   *  patches when any of the route's `reads:` machines change state — from
   *  any session, not just the viewer's own POSTs. Opt-in: routes without
   *  this flag operate purely on POST request/response. */
  live: boolean
}

export interface DefineRouteConfig<TReads extends ReadonlyArray<MachineDef<any, any>>> {
  reads: TReads
  render: (ctx: RouteRenderContext, request: RouteRequest) => HtmlFragment
  live?: boolean
}

export function defineRoute<TReads extends ReadonlyArray<MachineDef<any, any>>>(
  config: DefineRouteConfig<TReads>,
): RouteDefinition {
  return {
    __isStatorRoute: true,
    reads: [...config.reads],
    render: config.render,
    live: config.live ?? false,
  }
}

export function isStatorRoute(v: unknown): v is RouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorRoute === true
  )
}

/* ------------------------------------------------------------------ */
/* API routes (defineApiRoute)                                         */
/* ------------------------------------------------------------------ */

import type { Patch } from './recompute.ts'

/** A client directive describing a side effect the client should perform
 *  after applying patches. See the response-directives spec for the full list. */
export type Directive =
  | { type: 'navigate'; to: string }
  | { type: 'reload' }
  | { type: 'push-url'; to: string }
  | { type: 'replace-url'; to: string }
  | { type: 'focus'; target: { kind: 'slot' | 'element'; id: string } }
  | {
      type: 'scroll'
      target: { kind: 'slot' | 'element'; id: string }
      behavior?: 'smooth' | 'auto'
    }
  | { type: 'event'; name: string; detail?: unknown }

/** Envelope shape API route handlers return when they want the framework
 *  to synthesize an HTTP response. Returning a raw Response is also OK. */
export interface ApiRouteEnvelope {
  patches?: Patch[]
  directives?: Directive[]
}

export type ApiRouteResult = Response | ApiRouteEnvelope

/** Helpers available inside an API route handler. The framework provides
 *  these; user handlers ignore the ones they don't need. */
export interface ApiRouteHelpers {
  /** Dispatch an event to a named machine. Loads the machine if not already
   *  loaded, processes the event under the dispatch context, persists touched
   *  machines, fires cross-machine subscriptions. */
  dispatch: (machineName: string, event: { type: string; [k: string]: unknown }) => Promise<void>
}

export interface ApiRouteDefinition {
  readonly __isStatorApiRoute: true
  reads: MachineDef<any, any>[]
  handler: (request: RouteRequest, helpers: ApiRouteHelpers) => Promise<ApiRouteResult> | ApiRouteResult
}

export interface DefineApiRouteConfig<TReads extends ReadonlyArray<MachineDef<any, any>>> {
  reads?: TReads
  handler: (request: RouteRequest, helpers: ApiRouteHelpers) => Promise<ApiRouteResult> | ApiRouteResult
}

export function defineApiRoute<TReads extends ReadonlyArray<MachineDef<any, any>>>(
  config: DefineApiRouteConfig<TReads>,
): ApiRouteDefinition {
  return {
    __isStatorApiRoute: true,
    reads: config.reads ? [...config.reads] : [],
    handler: config.handler,
  }
}

export function isStatorApiRoute(v: unknown): v is ApiRouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorApiRoute === true
  )
}
