import type { Context } from 'hono'

/**
 * The resolved app config exposed to middleware off the Hono context. Set once,
 * early, by `buildHonoApp` so the security defaults, `cors()`, and app middleware
 * can read config without importing the config file. Config *data* only — no
 * per-request session yet (that needs an establish-once-per-request pass).
 */
export interface StatorContext {
  /** Canonical app origin (`config.origin`), if set. */
  readonly origin?: string
  /** Trusted cross-site write origins (`config.trustedOrigins`). */
  readonly trustedOrigins: readonly string[]
  /** Session cookie `SameSite` posture. */
  readonly sameSite: 'Lax' | 'Strict'
  /** Resolved CORS read policy, if the app configured `cors`. */
  readonly cors?: { readonly origins: readonly string[]; readonly credentials: boolean }
}

// Type `c.get('stator')` / `c.set('stator', …)`.
declare module 'hono' {
  interface ContextVariableMap {
    stator: StatorContext
  }
}

const DEFAULT: StatorContext = { trustedOrigins: [], sameSite: 'Lax' }

/**
 * Read Stator's request context — resolved config for middleware. Safe outside
 * the framework pipeline (returns inert defaults if the bridge never ran).
 */
export function stator(c: Context): StatorContext {
  return c.get('stator') ?? DEFAULT
}
