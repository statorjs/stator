import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

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

declare module 'hono' {
  interface ContextVariableMap {
    statorSession: SessionState
  }
}

/** The established session state for this request, if any. */
export function getSessionState(c: Context): SessionState | undefined {
  return c.get('statorSession')
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

export function getOrCreateSessionId(c: Context): {
  sessionId: string
  isNew: boolean
} {
  // Idempotent per request: the first caller (middleware or handler) establishes
  // the session; everyone after reads the same one. Closes the double-create bug.
  const established = c.get('statorSession')
  if (established) return { sessionId: established.sid, isNew: established.isNew }

  const cookieSid = getCookie(c, SESSION_COOKIE)
  const sessionId = cookieSid ?? randomUUID()
  const isNew = cookieSid === undefined
  if (isNew) setSessionCookie(c, sessionId)

  c.set('statorSession', { sid: sessionId, isNew, claims: undefined, claimsDirty: false })
  return { sessionId, isNew }
}
