import { createRenderState, type RenderState, runInRender } from './render-context.ts'
import type {
  RouteDefinition,
  RouteRenderContext,
  RouteRequest,
  RouteResponseContext,
} from './routing.ts'
import type { SessionRuntime } from './session-runtime.ts'

export interface RenderResult {
  html: string
  renderState: RenderState
  /** Response side effects the render function wrote (status, headers, cookies).
   *  Caller (HTTP layer) is responsible for applying these to the outgoing
   *  HTTP response. */
  response: RenderedResponseEffects
}

export interface RenderedResponseEffects {
  status: number
  headers: Headers
  cookies: Array<{
    name: string
    value: string
    options: import('./routing.ts').RouteCookieOptions | undefined
    deleted: boolean
  }>
}

/**
 * Build a fresh RouteResponseContext for a render. The render function
 * mutates this; the HTTP layer reads back the effects and applies them
 * to the outgoing Response.
 */
function createResponseContext(): {
  ctx: RouteResponseContext
  effects: RenderedResponseEffects
} {
  const effects: RenderedResponseEffects = {
    status: 200,
    headers: new Headers(),
    cookies: [],
  }
  const ctx: RouteResponseContext = {
    get status() {
      return effects.status
    },
    set status(s: number) {
      effects.status = s
    },
    headers: effects.headers,
    cookies: {
      set(name, value, options) {
        effects.cookies.push({ name, value, options, deleted: false })
      },
      delete(name, options) {
        effects.cookies.push({
          name,
          value: '',
          options: { ...options, maxAge: 0 },
          deleted: true,
        })
      },
    },
  }
  return { ctx, effects }
}

/**
 * Build the route's render context from a SessionRuntime (which already
 * holds transient proxies for every machine the route depends on), then
 * invoke the route's render function under a fresh RenderState.
 *
 * RenderState lifetime in the current model is request-scoped: a GET
 * discards it after the response, a POST keeps it just long enough to
 * run `recompute` against the post-event state. SSE connections retain
 * it for the connection's lifetime.
 *
 * `request` carries URL-derived state and body access. `response` carries
 * side-effect helpers (status, headers, cookies). The render function
 * returns the rendered HTML; the HTTP layer combines the HTML with the
 * response effects to build the final Response.
 */
export function renderRoute(
  route: RouteDefinition,
  routeKey: string,
  sessionId: string,
  runtime: SessionRuntime,
  request: RouteRequest,
): RenderResult {
  const state = createRenderState(sessionId, routeKey)
  const { ctx: responseCtx, effects } = createResponseContext()
  const renderCtx: RouteRenderContext = { response: responseCtx } as RouteRenderContext

  for (const def of route.reads) {
    if (def.name === 'response') {
      throw new Error(
        'stator: a machine cannot be named "response"; the render context reserves that key',
      )
    }
    const proxy = runtime.proxyFor(def.name)
    if (!proxy) {
      throw new Error(`stator: route reads "${def.name}" but it's not loaded into the runtime`)
    }
    ;(renderCtx as Record<string, unknown>)[def.name] = proxy
  }
  const fragment = runInRender(state, () => route.render(renderCtx, request))
  return { html: fragment.html, renderState: state, response: effects }
}
