import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { safeNavigationUrl } from '../wire/safe-url.ts'
import { scheduleSessionEffects } from './effects.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'
import type { RenderedResponseEffects } from './render.ts'
import type { DiscoveredRoute } from './route-discovery.ts'
import { buildRouteRequest } from './route-request.ts'
import type {
  ApiRouteDefinition,
  ApiRouteEnvelope,
  ApiRouteHelpers,
  Directive,
  RouteRequest,
} from './routing.ts'
import { getOrCreateSessionId, setSessionCookie } from './session.ts'
import { withSessionLock } from './session-lock.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut } from './sse.ts'

const apiLog = scopedLogger('api')

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
  let rotation: { clear: boolean } | null = null
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

      const helpers: ApiRouteHelpers = {
        dispatch: async (machine, event) => {
          // API routes have no render target to diff against, so dispatches
          // here don't produce patches. (Patches from API-route dispatches
          // would need a target page; that's a future spec.)
          // The target machine is addressed by its def; read the name off it.
          const dispatchedTouched = runtime.processEvent(machine.name, event)
          for (const name of dispatchedTouched) touched.add(name)
          // Same honesty as client dispatch: a guard-dropped event commits
          // nothing, and handlers (login flows especially) need to know.
          return { committed: dispatchedTouched.size > 0 }
        },
        rotateSession: (opts) => {
          rotation = { clear: opts?.clear === true }
        },
      }

      let result: Response | ApiRouteEnvelope
      try {
        result = await route.handler(request, helpers)
      } catch (err) {
        apiLog.error({ err: String(err), path: c.req.path }, 'api route handler threw')
        return c.text('Internal Server Error', 500)
      }

      // Persist committed machines plus any fresh machine that fired its initial
      // entry effect (not in `touched` — an entry commits no transition), so it
      // isn't re-created and re-fired next request. Fan-out stays on `touched`.
      const toPersist = new Set([...touched, ...runtime.entryFiredMachines()])
      if (toPersist.size > 0) {
        await runtime.persistTouched(toPersist)
      }
      if (touched.size > 0) {
        await fanOut(touched, { sessionId })
      }

      // Session rotation (fixation defense). Order matters: the runtime has
      // already persisted under the OLD id and fan-out has reached the old
      // id's connections (about to be navigated away) — now the whole
      // session moves (or, for logout, dies) and the response carries the
      // new cookie. Effect completions must chase the NEW id.
      let effectsSessionId = sessionId
      if (rotation !== null) {
        const newSessionId = randomUUID()
        if ((rotation as { clear: boolean }).clear) {
          await store.persistence.deleteSession(sessionId)
        } else {
          if (!store.persistence.renameSession) {
            throw new Error(
              'stator: rotateSession requires a store with renameSession — ' +
                'the configured custom store does not implement it.',
            )
          }
          await store.persistence.renameSession(sessionId, newSessionId)
        }
        setSessionCookie(c, newSessionId)
        effectsSessionId = newSessionId
      }
      // Effects queued by dispatched events run after this callback returns
      // (never under the session lock); see server/effects.ts.
      scheduleSessionEffects(runtime, store, effectsSessionId)

      // Escape hatch: handler returned a real Response. Pass through.
      if (result instanceof Response) return result

      const envelope = result as ApiRouteEnvelope
      return synthesizeResponse(c, request, envelope)
    } finally {
      runtime.dispose()
    }
  })
}

/** The Referer header is attacker-controllable, so redirecting back to it is an
 *  open-redirect vector. Return a same-origin relative path (pathname+search)
 *  when the referer matches this request's origin, else '/'. */
function sameOriginReferer(request: RouteRequest): string {
  const ref = request.headers.get('referer')
  if (!ref) return '/'
  try {
    const refUrl = new URL(ref)
    if (refUrl.origin !== new URL(request.url).origin) return '/'
    return `${refUrl.pathname}${refUrl.search}`
  } catch {
    return '/'
  }
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
      // Never emit a javascript:/vbscript:/data: Location — coerce to '/'.
      return c.redirect(safeNavigationUrl(navigate.to), 303)
    }
    const reload = envelope.directives?.find((d) => d.type === 'reload')
    if (reload) {
      // The Referer is attacker-controllable; only bounce back to it when it's
      // same-origin, else fall back to '/' (no open redirect).
      return c.redirect(sameOriginReferer(request), 303)
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
export function applyRenderedEffects(c: Context, effects: RenderedResponseEffects): void {
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
