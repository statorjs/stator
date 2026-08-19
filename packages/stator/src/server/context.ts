import type { Context } from 'hono'
import { type CookieJar, cookieJar } from './cookies.ts'
import { getSessionState, rotateSessionNow } from './session.ts'
import type { Store } from './store.ts'

/**
 * The resolved config data `buildHonoApp` stashes on the context (early), for
 * the security defaults, `cors()`, and app middleware to read.
 */
export interface StatorConfigData {
  readonly origin?: string
  readonly trustedOrigins: readonly string[]
  readonly sameSite: 'Lax' | 'Strict'
  readonly cors?: { readonly origins: readonly string[]; readonly credentials: boolean }
}

// Type `c.get('stator')` / `c.set('stator', …)` — the stored config data, plus
// the store the bridge stashes so middleware session ops can rotate/clear now.
declare module 'hono' {
  interface ContextVariableMap {
    stator: StatorConfigData
    statorStore: { persistence: Store }
    /** Signed-cookie signing key, stashed by the bridge when configured. */
    statorSecret: string
  }
}

/**
 * What `stator(c)` returns — resolved config *plus* per-request session ops.
 * Read it in middleware; handlers get the same ops on their `ctx`.
 */
export interface StatorContext {
  readonly origin?: string
  readonly trustedOrigins: readonly string[]
  readonly sameSite: 'Lax' | 'Strict'
  readonly cors?: { readonly origins: readonly string[]; readonly credentials: boolean }

  /** The established session id for this request. */
  readonly sid: string
  /** Read this session's app-defined claims (identity/data). `undefined` if none. */
  claims<T = unknown>(): T | undefined
  /** Replace this session's claims — persisted at request end. */
  setClaims(claims: unknown): void
  /** Drop this session's claims (keeps the session) — persisted at request end. */
  clearClaims(): void
  /** Rotate the session id *now* (fixation defense on privilege change): state
   *  moves to a fresh id, the response carries the new cookie. Immediate because
   *  middleware runs upstream of the handler pipeline. */
  rotateSession(opts?: { clear?: boolean }): Promise<void>
  /** Destroy this session *now* — its state is deleted and the browser starts
   *  anonymous. Sugar for `rotateSession({ clear: true })`. */
  clearSession(): Promise<void>
  /** Read/write app-owned cookies (e.g. a login `returnTo`). Distinct from the
   *  framework-managed session cookie. */
  readonly cookies: CookieJar
}

const DEFAULT: StatorConfigData = { trustedOrigins: [], sameSite: 'Lax' }

/**
 * Read Stator's request context — resolved config + session ops. Safe outside the
 * framework pipeline (inert config defaults, empty session) if the bridge/session
 * setup never ran.
 */
export function stator(c: Context): StatorContext {
  const cfg = c.get('stator') ?? DEFAULT
  const session = getSessionState(c)
  return {
    origin: cfg.origin,
    trustedOrigins: cfg.trustedOrigins,
    sameSite: cfg.sameSite,
    cors: cfg.cors,
    get sid() {
      return session?.sid ?? ''
    },
    claims<T = unknown>(): T | undefined {
      return session?.claims as T | undefined
    },
    setClaims(claims: unknown): void {
      if (session) {
        session.claims = claims
        session.claimsDirty = true
      }
    },
    clearClaims(): void {
      if (session) {
        session.claims = undefined
        session.claimsDirty = true
      }
    },
    async rotateSession(opts?: { clear?: boolean }): Promise<void> {
      const store = c.get('statorStore')
      if (!store) return // inert outside the framework pipeline
      await rotateSessionNow(c, store, opts)
    },
    async clearSession(): Promise<void> {
      const store = c.get('statorStore')
      if (!store) return
      await rotateSessionNow(c, store, { clear: true })
    },
    cookies: cookieJar(c),
  }
}
