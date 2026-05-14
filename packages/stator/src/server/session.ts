import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'stator_sid'

/** Secure cookie flag — set when running behind HTTPS. Enabled by
 *  NODE_ENV=production; can be overridden via STATOR_SECURE_COOKIE. */
function shouldUseSecureCookie(): boolean {
  if (process.env.STATOR_SECURE_COOKIE === '1') return true
  if (process.env.STATOR_SECURE_COOKIE === '0') return false
  return process.env.NODE_ENV === 'production'
}

export function getOrCreateSessionId(c: Context): { sessionId: string; isNew: boolean } {
  const existing = getCookie(c, SESSION_COOKIE)
  if (existing) return { sessionId: existing, isNew: false }
  const sessionId = randomUUID()
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: shouldUseSecureCookie(),
  })
  return { sessionId, isNew: true }
}
