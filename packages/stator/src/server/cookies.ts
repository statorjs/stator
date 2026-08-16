import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { RouteCookieOptions } from './routing.ts'

/**
 * A focused read/write cookie surface for app-owned cookies (a login
 * `returnTo`, a consent flag, a theme). Thin over `hono/cookie` — no jar state,
 * writes append `Set-Cookie` on the response immediately.
 *
 * `get` reads the *inbound* request cookie: a `set` this request is not visible
 * to a later `get` in the same request (standard cookie semantics). The session
 * cookie (`stator_sid`) is framework-managed — use the session ops, not this.
 */
export interface CookieJar {
  /** The inbound value of `name`, or `undefined` if absent. */
  get(name: string): string | undefined
  /** Write a cookie on the response. Defaults are hono's (not HttpOnly/Secure);
   *  pass options for auth-shaped cookies. */
  set(name: string, value: string, options?: RouteCookieOptions): void
  /** Expire a cookie. `path`/`domain` must match how it was set. */
  delete(name: string, options?: Pick<RouteCookieOptions, 'path' | 'domain'>): void
}

/** Build the cookie jar bound to a request context. Shared by `stator(c)`
 *  (middleware) and the API-route handler `ctx`, so both read/write cookies
 *  the same way. */
export function cookieJar(c: Context): CookieJar {
  return {
    get: (name) => getCookie(c, name),
    set: (name, value, options) => {
      setCookie(c, name, value, options as never)
    },
    delete: (name, options) => {
      deleteCookie(c, name, options as never)
    },
  }
}
