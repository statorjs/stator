import type { Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
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
  /** Expire a cookie. `path`/`domain` must match how it was set. Works for
   *  signed cookies too — deletion needs no signature. */
  delete(name: string, options?: Pick<RouteCookieOptions, 'path' | 'domain'>): void
  /** Read a signed cookie, verifying its signature against the app secret.
   *  `undefined` if absent OR the signature is invalid (tampered, or signed
   *  with a since-rotated secret) — an untrustworthy value is treated as absent.
   *  Throws if no secret is configured. The sealed short-lived-state read
   *  (OAuth `state`/PKCE, a magic-link token, a WebAuthn challenge). */
  getSigned(name: string): Promise<string | undefined>
  /** Write a signed cookie — the value is tamper-evident, not encrypted (still
   *  readable by the client, so don't put secrets *in* it; put a nonce it can't
   *  forge). Throws if no secret is configured. */
  setSigned(name: string, value: string, options?: RouteCookieOptions): Promise<void>
}

/** Read the configured signing secret, or throw a fix-it error. */
function requireSecret(c: Context): string {
  const secret = c.get('statorSecret')
  if (!secret) {
    throw new Error(
      'stator: signed cookies require a secret — set `secret` in stator.config.ts ' +
        'or `STATOR_SECRET` in the environment (e.g. .env.local).',
    )
  }
  return secret
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
    getSigned: async (name) => {
      // hono returns `false` for a present-but-invalid signature; collapse it to
      // undefined so callers never trust (or even see) a tampered value.
      const value = await getSignedCookie(c, requireSecret(c), name)
      return value === false ? undefined : value
    },
    setSigned: async (name, value, options) => {
      await setSignedCookie(c, name, value, requireSecret(c), options as never)
    },
  }
}
