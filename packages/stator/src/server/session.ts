import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Store } from './store.ts'

export const SESSION_COOKIE = 'stator_sid'

/** Reserved storage-key prefix — framework-only. Machine names may not use it,
 *  so per-session framework keys (like claims) can't collide with a machine. */
export const RESERVED_KEY_PREFIX = '__'
/** Session-claims storage key (a reserved pseudo-machine name in the Store). */
export const CLAIMS_KEY = '__claims'

/** Per-request session state — established once and shared across middleware and
 *  handlers so they see one `sid` (and one claims snapshot), instead of each
 *  calling `getOrCreateSessionId` and risking two ids on a first request. */
export interface SessionState {
  sid: string
  isNew: boolean
  /** App-defined claims; `undefined` until loaded (returning sessions) or set. */
  claims: unknown
  /** Set when claims changed this request and must persist at request end. */
  claimsDirty: boolean
}

/** Layer-3 provability tracking: did this request USE the session plane
 *  (establish/dispatch/session-read) or READ claims? Either makes the
 *  response unprovable as anonymous-identical, so no derived Cache-Control. */
export interface SessionUse {
  used: boolean
  claimsRead: boolean
}

declare module 'hono' {
  interface ContextVariableMap {
    statorSession: SessionState
    statorSessionUse: SessionUse
  }
}

/** The established session state for this request, if any. */
export function getSessionState(c: Context): SessionState | undefined {
  return c.get('statorSession')
}

/** The request's session-use flags (created on first access). */
export function sessionUse(c: Context): SessionUse {
  let use = c.get('statorSessionUse')
  if (!use) {
    use = { used: false, claimsRead: false }
    c.set('statorSessionUse', use)
  }
  return use
}

/** The session id this request WOULD have — established state or the arriving
 *  cookie — without creating anything. Null for a first-contact visitor. */
export function peekSessionId(c: Context): string | null {
  return getSessionState(c)?.sid ?? getCookie(c, SESSION_COOKIE) ?? null
}

/** Resume an EXISTING session from the arriving cookie (populate the shared
 *  state, no cookie write) — or return null for first contact. Resuming is
 *  not establishment: laziness governs CREATION only. */
export function resumeSession(c: Context): SessionState | null {
  const established = getSessionState(c)
  if (established) return established
  const cookieSid = getCookie(c, SESSION_COOKIE)
  if (cookieSid === undefined) return null
  const state: SessionState = {
    sid: cookieSid,
    isNew: false,
    claims: undefined,
    claimsDirty: false,
  }
  c.set('statorSession', state)
  return state
}

/** Secure cookie flag — set when running behind HTTPS. Enabled by
 *  NODE_ENV=production; can be overridden via STATOR_SECURE_COOKIE. */
function shouldUseSecureCookie(): boolean {
  if (process.env.STATOR_SECURE_COOKIE === '1') return true
  if (process.env.STATOR_SECURE_COOKIE === '0') return false
  return process.env.NODE_ENV === 'production'
}

/** The session cookie's `SameSite`. `Lax` (default) allows same-site sibling
 *  subdomains; `Strict` withholds the cookie from every cross-site request (the
 *  controlled posture — paired with the guard's allowlist-only same-site branch).
 *  Set once at app construction; every `createApp` re-sets it, so it can't leak
 *  across apps in one process. */
let cookieSameSite: 'Lax' | 'Strict' = 'Lax'

/** Configure the session cookie's `SameSite`. Called at app construction. */
export function setSessionSameSite(value: 'Lax' | 'Strict'): void {
  cookieSameSite = value
}

/** Write the session cookie — shared by session creation and rotation so
 *  the flags can never drift apart. */
export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: cookieSameSite,
    path: '/',
    secure: shouldUseSecureCookie(),
  })
}

/**
 * ESTABLISH the session — the lazy-creation trigger (dispatches, session-
 * machine reads, SSE connects, explicit session ops call this; anonymous
 * page/data GETs never do). Idempotent per request: the first caller
 * establishes, everyone after reads the same state. A first-contact visitor
 * gets a fresh sid + Set-Cookie HERE and nowhere earlier — the whole
 * cacheable-read-path layer 1.
 */
export function getOrCreateSessionId(c: Context): {
  sessionId: string
  isNew: boolean
} {
  sessionUse(c).used = true
  const resumed = resumeSession(c)
  if (resumed) return { sessionId: resumed.sid, isNew: resumed.isNew }

  const sessionId = randomUUID()
  setSessionCookie(c, sessionId)
  c.set('statorSession', { sid: sessionId, isNew: true, claims: undefined, claimsDirty: false })
  return { sessionId, isNew: true }
}

/**
 * Rotate (or, with `clear`, destroy) the current session *right now* and update
 * the shared session state + cookie. The immediate counterpart to a handler's
 * deferred `rotateSession`/`clearSession` — used from middleware, which runs
 * upstream of the machine pipeline and has no "after the handler" seam.
 *
 * Rotate: state moves to a fresh id (fixation defense on privilege change);
 * any claims set this request follow to the new id at persist time. Clear: the
 * old session's state is DELETED and the browser starts anonymous. Returns the
 * new session id.
 */
export async function rotateSessionNow(
  c: Context,
  store: { persistence: Pick<Store, 'deleteSession' | 'renameSession'> },
  opts?: { clear?: boolean },
): Promise<string> {
  const { sessionId } = getOrCreateSessionId(c)
  const clear = opts?.clear === true
  const newSessionId = randomUUID()
  if (clear) {
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
  const session = getSessionState(c)
  if (session) {
    session.sid = newSessionId
    if (clear) {
      session.claims = undefined
      session.claimsDirty = false
    }
  }
  return newSessionId
}
