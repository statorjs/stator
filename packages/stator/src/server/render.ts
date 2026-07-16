import { deferSentinel } from '../template/defer.ts'
import { isHtmlFragment } from '../template/types.ts'
import {
  createRenderState,
  type DeferRecord,
  popDeferScope,
  pushDeferScope,
  type RenderState,
  runInRender,
} from './render-context.ts'
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
export interface RenderRouteOptions {
  /** Resolve `defer` slots (default true). The `/__events` re-diff baseline
   *  passes false: it runs under the session lock and must not kick defer I/O;
   *  its defer slots emit inert placeholders that the diff never touches. */
  resolveDeferred?: boolean
}

export async function renderRoute(
  route: RouteDefinition,
  routeKey: string,
  sessionId: string,
  runtime: SessionRuntime,
  request: RouteRequest,
  opts: RenderRouteOptions = {},
): Promise<RenderResult> {
  const state = createRenderState(sessionId, routeKey)
  state.resolveDeferred = opts.resolveDeferred ?? true
  const { ctx: responseCtx, effects } = createResponseContext()
  const renderCtx: RouteRenderContext = {
    response: responseCtx,
  } as RouteRenderContext

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
  let html = fragment.html
  if (state.resolveDeferred && state.deferred.length > 0) {
    html = await resolveDeferred(state, html)
  }
  return { html, renderState: state, response: effects }
}

/**
 * The `defer` resolve phase (v1: blocking-inline, no streaming). Runs after the
 * synchronous render, so it can `await` without losing `currentRenderState`.
 *
 * Drains `state.deferred` in batches: a resolve-window yield lets already-ready
 * data settle with no added latency, then the batch's resources are awaited in
 * parallel (bounded by the slowest, not the sum), then each slot's arm is
 * rendered and spliced into its sentinel. A defer arm may itself contain a
 * defer, which records during fill — so the loop drains until the page is quiet.
 */
async function resolveDeferred(state: RenderState, html: string): Promise<string> {
  while (state.deferred.length > 0) {
    const batch = state.deferred
    state.deferred = []
    // Macrotask yield: sync values, warm caches, already-resolved promises, and
    // multi-hop-but-instant chains settle here; real network/disk I/O does not.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.all(batch.map((record) => record.resource.settled))
    for (const record of batch) {
      html = html.replace(deferSentinel(record.slotId), fillDeferSlot(state, record))
    }
  }
  return html
}

/** Render a resolved defer slot's arm, scoped under the slot id (so nested
 *  static constructs get stable ids and machine reads are rejected). */
function fillDeferSlot(state: RenderState, record: DeferRecord): string {
  return runInRender(state, () => {
    pushDeferScope(state, record.slotId)
    try {
      const { resource } = record
      let fragment: ReturnType<DeferRecord['ready']>
      if (resource.status === 'fulfilled') {
        fragment = record.ready(resource.value)
      } else if (record.error) {
        fragment = record.error(resource.reason)
      } else {
        // No error arm — let the rejection bubble to route-level error handling.
        throw resource.reason
      }
      if (!isHtmlFragment(fragment)) {
        throw new Error('stator: a defer() ready/error arm must return an html`...` result')
      }
      return fragment.html
    } finally {
      popDeferScope(state)
    }
  })
}
