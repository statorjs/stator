import type { HtmlFragment } from '../template/types.ts'
import type { WireEnvelope } from '../wire/index.ts'
import type { AnyMachineDef, EventOf, ReadsMap } from './define-machine.ts'

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
  reads: AnyMachineDef[]
  render: (ctx: RouteRenderContext, request: RouteRequest) => HtmlFragment
  /** When true, the rendered page opens an SSE channel that receives
   *  patches when any of the route's `reads:` machines change state — from
   *  any session, not just the viewer's own POSTs. Opt-in: routes without
   *  this flag operate purely on POST request/response. */
  live: boolean
}

export interface DefineRouteConfig<TReads extends ReadonlyArray<AnyMachineDef>> {
  reads: TReads
  render: (ctx: RouteRenderContext, request: RouteRequest) => HtmlFragment
  live?: boolean
}

export function defineRoute<TReads extends ReadonlyArray<AnyMachineDef>>(
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
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isStatorRoute === true
  )
}

/* ------------------------------------------------------------------ */
/* API routes (defineApiRoute)                                         */
/* ------------------------------------------------------------------ */

export type { Directive } from '../wire/index.ts'

/** Envelope shape API route handlers return when they want the framework
 *  to synthesize an HTTP response. Returning a raw Response is also OK.
 *  Same shape as the wire envelope the client receives. */
export type ApiRouteEnvelope = WireEnvelope

export type ApiRouteResult = Response | ApiRouteEnvelope

/** Helpers available inside an API route handler. The framework provides
 *  these; user handlers ignore the ones they don't need. */
export interface ApiRouteHelpers {
  /** Dispatch an event to a machine, addressed by the imported machine def
   *  (not a magic string). The target name is read from `machine.name`; the
   *  event is type-checked against that machine's declared event union.
   *  Processes the event under the dispatch context, persists touched machines,
   *  fires cross-machine subscriptions. The machine must be in the route's
   *  loaded graph (its `reads`, transitively). */
  dispatch: <D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ) => Promise<{ committed: boolean }>
  /** Rotate the session id — the fixation defense for privilege changes.
   *  Call on login (state moves to a fresh id; the old id becomes worthless
   *  to anyone who captured it) and on logout with `{ clear: true }` (the
   *  old session's state is DELETED and the browser starts anonymous).
   *  Applied after the handler returns: state persists under the new id and
   *  the response carries the new cookie. Requires a store with
   *  `renameSession` (all built-in stores have it). */
  rotateSession: (opts?: { clear?: boolean }) => void
  /** Read this session's app-defined claims (identity/data). `undefined` if none. */
  claims: <T = unknown>() => T | undefined
  /** Replace this session's claims — persisted at request end. */
  setClaims: (claims: unknown) => void
  /** Drop this session's claims (keeps the session) — persisted at request end. */
  clearClaims: () => void
  /** Destroy this session — its state is deleted and the browser starts
   *  anonymous. Sugar for `rotateSession({ clear: true })`; applied after the
   *  handler returns. */
  clearSession: () => void
}

export interface ApiRouteDefinition {
  readonly __isStatorApiRoute: true
  reads: AnyMachineDef[]
  handler: (
    request: RouteRequest,
    helpers: ApiRouteHelpers,
  ) => Promise<ApiRouteResult> | ApiRouteResult
}

export interface DefineApiRouteConfig<TReads extends ReadonlyArray<AnyMachineDef>> {
  reads?: TReads
  handler: (
    request: RouteRequest,
    helpers: ApiRouteHelpers,
  ) => Promise<ApiRouteResult> | ApiRouteResult
}

/** `method: 'GET'` discriminates: with it, the handler is a read-only data
 *  route typed with `{ machines }`; without it, a command route typed with
 *  `{ dispatch, rotateSession }` — exactly as before. */
export function defineApiRoute<TReads extends ReadonlyArray<AnyMachineDef> = readonly []>(
  config: DefineQueryRouteConfig<TReads>,
): QueryRouteDefinition
export function defineApiRoute<TReads extends ReadonlyArray<AnyMachineDef>>(
  config: DefineApiRouteConfig<TReads>,
): ApiRouteDefinition
export function defineApiRoute<TReads extends ReadonlyArray<AnyMachineDef>>(
  config: DefineQueryRouteConfig<TReads> | DefineApiRouteConfig<TReads>,
): QueryRouteDefinition | ApiRouteDefinition {
  if ('method' in config && config.method === 'GET') {
    return {
      __isStatorQueryRoute: true,
      reads: config.reads ? [...config.reads] : [],
      handler: config.handler,
    }
  }
  return {
    __isStatorApiRoute: true,
    reads: config.reads ? [...config.reads] : [],
    handler: (config as DefineApiRouteConfig<TReads>).handler,
  }
}

export function isStatorApiRoute(v: unknown): v is ApiRouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorApiRoute === true
  )
}

/* ------------------------------------------------------------------ */
/* Data GET routes (defineApiRoute with method: 'GET')                 */
/* ------------------------------------------------------------------ */

/** Helpers available inside a data GET handler. Read-only by construction:
 *  there is no `dispatch` here, and that structural absence is what makes
 *  handler reads safe — a handler that cannot dispatch has nothing to
 *  interleave with effect completions or other sessions' commits. */
export interface QueryRouteHelpers<
  TReads extends ReadonlyArray<AnyMachineDef> = ReadonlyArray<AnyMachineDef>,
> {
  /** Read proxies keyed by machine name — the same shape a page's render
   *  context uses (selector + context reads; no send). Typed off the route's
   *  `reads:` tuple (`ReadsMap`), so `machines.SitesMachine` is a real proxy
   *  and a mistyped name is a compile error rather than `unknown`. The default
   *  keeps the erased runtime definition loose. */
  machines: ReadsMap<TReads>
}

/** What a data GET handler may return: a raw `Response` (passed through
 *  verbatim, `Content-Type` filled from the URL extension only when the
 *  handler set none), a string (`Content-Type` from the URL extension,
 *  `text/plain` fallback), or any JSON-serializable value (always
 *  `application/json`). */
export type QueryRouteResult = Response | string | object

export interface QueryRouteDefinition {
  readonly __isStatorQueryRoute: true
  reads: AnyMachineDef[]
  handler: (
    request: RouteRequest,
    helpers: QueryRouteHelpers,
  ) => Promise<QueryRouteResult> | QueryRouteResult
}

export interface DefineQueryRouteConfig<TReads extends ReadonlyArray<AnyMachineDef> = readonly []> {
  /** The capability discriminant: `'GET'` declares a read-only data route.
   *  Discovery cross-checks it against the export name. */
  method: 'GET'
  reads?: TReads
  handler: (
    request: RouteRequest,
    helpers: QueryRouteHelpers<TReads>,
  ) => Promise<QueryRouteResult> | QueryRouteResult
}

export function isStatorQueryRoute(v: unknown): v is QueryRouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorQueryRoute === true
  )
}
