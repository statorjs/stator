import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { z } from 'zod'

import type { MachineStore } from './machine-store.ts'
import { SessionRuntime } from './session-runtime.ts'
import { recompute, type Patch } from './recompute.ts'
import { renderRoute } from './render.ts'
import { fanOut } from './sse.ts'
import { getOrCreateSessionId } from './session.ts'
import { buildRouteRequest } from './route-request.ts'
import type {
  ApiRouteDefinition,
  ApiRouteEnvelope,
  ApiRouteHelpers,
  Directive,
  RouteRequest,
} from './routing.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import type { RenderedResponseEffects } from './render.ts'
import { scopedLogger } from './logger.ts'

const apiLog = scopedLogger('api')

/**
 * Per-session async lock for API routes. Same shape as the /__events lock
 * so two concurrent mutations against the same session serialize cleanly.
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

/**
 * Run an API route handler under a fresh SessionRuntime, marshal the
 * result into an HTTP response, fan-out to live SSE connections.
 *
 * The handler can return:
 *   - A raw Response (escape hatch; framework returns it verbatim).
 *   - A directives envelope `{ patches?, directives? }`. The framework
 *     synthesizes the HTTP response based on the client's Accept header:
 *     `text/html` gets a 303 redirect (or a re-render of the source page);
 *     anything else (default JSON for the client runtime) gets the
 *     envelope as JSON.
 */
export async function runApiRoute(
  c: Context,
  discovered: DiscoveredRoute,
  route: ApiRouteDefinition,
  store: MachineStore,
  /** Path params from the framework's own matcher (the dispatch catch-all
   *  bypasses Hono's per-route param extraction). */
  params?: Record<string, string>,
): Promise<Response> {
  const { sessionId } = getOrCreateSessionId(c)
  const request = params
    ? { ...buildRouteRequest(c, discovered.paramNames), params }
    : buildRouteRequest(c, discovered.paramNames)

  return withSessionLock(sessionId, async () => {
    const runtime = new SessionRuntime(sessionId, store)
    try {
      await runtime.loadGraph(route.reads)
      runtime.wireSubscriptions()

      // Track which machines got touched so we can persist + fan-out.
      const touched = new Set<string>()
      const recordedPatches: Patch[] = []

      // Pre-event renderState placeholder; created lazily on first dispatch
      // because not all API routes dispatch events.
      let renderState: import('./render-context.ts').RenderState | null = null

      const helpers: ApiRouteHelpers = {
        dispatch: async (machine, event) => {
          if (!renderState) {
            // First dispatch: capture the originating page's bindings if
            // this route corresponds to a visible page. For now, skip the
            // pre-event render — API routes don't have a render target to
            // diff against, so they only produce patches that we don't
            // currently capture. (Patches from API-route dispatches would
            // need a target page; that's a future spec.)
          }
          // The target machine is addressed by its def; read the name off it.
          const dispatchedTouched = runtime.processEvent(machine.name, event)
          for (const name of dispatchedTouched) touched.add(name)
        },
      }

      let result: Response | ApiRouteEnvelope
      try {
        result = await route.handler(request, helpers)
      } catch (err) {
        apiLog.error({ err: String(err), path: c.req.path }, 'api route handler threw')
        return c.text('Internal Server Error', 500)
      }

      if (touched.size > 0) {
        await runtime.persistTouched(touched)
        await fanOut(touched)
      }

      // Escape hatch: handler returned a real Response. Pass through.
      if (result instanceof Response) return result

      const envelope = result as ApiRouteEnvelope
      return synthesizeResponse(c, request, envelope)
    } finally {
      runtime.dispose()
    }
  })
}

/**
 * Content-negotiated response synthesis from a directives envelope.
 *
 * - HTML clients (Accept includes text/html, typical for raw browser form
 *   POSTs) get an HTTP-native equivalent. The first `navigate` directive
 *   becomes a 303 + Location. `reload` becomes a 303 back to the referer.
 *   Without a directive, return a minimal 204.
 * - JSON clients (client runtime, default) get the envelope as JSON.
 */
function synthesizeResponse(
  c: Context,
  request: RouteRequest,
  envelope: ApiRouteEnvelope,
): Response {
  const accept = request.headers.get('accept') ?? ''
  const wantsHtml = accept.includes('text/html') && !accept.includes('application/json')

  if (wantsHtml) {
    const navigate = envelope.directives?.find(
      (d): d is Extract<Directive, { type: 'navigate' }> => d.type === 'navigate',
    )
    if (navigate) {
      return c.redirect(navigate.to, 303)
    }
    const reload = envelope.directives?.find((d) => d.type === 'reload')
    if (reload) {
      const ref = request.headers.get('referer') ?? '/'
      return c.redirect(ref, 303)
    }
    // No actionable directive for a no-JS client. Send a minimal 204.
    return new Response(null, { status: 204 })
  }

  // JSON / client-runtime path.
  return c.json({
    patches: envelope.patches ?? [],
    directives: envelope.directives ?? [],
  })
}

/** Apply rendered response effects (cookies, headers, status) to a Hono
 *  context. Used for GET routes that wrote to the response side-effect
 *  surface during render. */
export function applyRenderedEffects(
  c: Context,
  effects: RenderedResponseEffects,
): void {
  effects.headers.forEach((value, key) => {
    c.header(key, value)
  })
  for (const cookie of effects.cookies) {
    setCookie(c, cookie.name, cookie.value, cookie.options as never)
  }
  if (effects.status !== 200) {
    c.status(effects.status as never)
  }
}
