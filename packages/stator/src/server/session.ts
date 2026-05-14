import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'stator_sid'

export function getOrCreateSessionId(c: Context): { sessionId: string; isNew: boolean } {
  const existing = getCookie(c, SESSION_COOKIE)
  if (existing) return { sessionId: existing, isNew: false }
  const sessionId = randomUUID()
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  })
  return { sessionId, isNew: true }
}
