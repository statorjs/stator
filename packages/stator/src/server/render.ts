import { createRenderState, runInRender, type RenderState } from './render-context.ts'
import type { SessionRuntime } from './session-runtime.ts'
import type { RouteDefinition } from './routing.ts'

export interface RenderResult {
  html: string
  renderState: RenderState
}

/**
 * Build the route's render context from a SessionRuntime (which already
 * holds transient proxies for every machine the route depends on), then
 * invoke the route's render function under a fresh RenderState.
 *
 * RenderState lifetime in the current model is request-scoped: a GET
 * discards it after the response, a POST keeps it just long enough to
 * run `recompute` against the post-event state. SSE connections (V1)
 * will retain it for the connection's lifetime.
 */
export function renderRoute(
  route: RouteDefinition,
  routeKey: string,
  sessionId: string,
  runtime: SessionRuntime,
): RenderResult {
  const state = createRenderState(sessionId, routeKey)
  const ctx: Record<string, unknown> = {}
  for (const def of route.reads) {
    const proxy = runtime.proxyFor(def.name)
    if (!proxy) {
      throw new Error(
        `stator: route reads "${def.name}" but it's not loaded into the runtime`,
      )
    }
    ctx[def.name] = proxy
  }
  const fragment = runInRender(state, () => route.render(ctx))
  return { html: fragment.html, renderState: state }
}
