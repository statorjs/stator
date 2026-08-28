import type { AppStore, Store } from './server/index.ts'

/** Log verbosity, from most to least severe. Setting a level emits it and
 *  everything above it — `warn` shows `warn`+`error`+`fatal`, hiding
 *  `info`/`debug`. Pino's levels. */
export type LogLevel = 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Stator app configuration — the home for what previously forced a hand-written
 * `server.ts`/`start.ts`: the persistence adapters, session/realtime policy, and
 * dev port.
 *
 * Loaded from `stator.config.{ts,mts,js,mjs}` at the app root by the `stator`
 * CLI (`dev`/`start`). Grouped by concern so the config principle is visible in
 * the shape: `persistence` holds the swappable adapters (infra); `sessions` /
 * `realtime` / `dev` hold policy. Config owns *how it runs*, never *what it does*
 * (behavior — e.g. a route's `live` flag — stays in code).
 *
 * Every field is optional; omit the file entirely to accept defaults (in-memory
 * persistence, 24h session TTL, port 3000). There is no required machine-graph
 * entry point — machines are file-discovered from `machines/`.
 */
export interface StatorConfig {
  /** Listen port for `dev`/`start`. Precedence: `--port` flag > `$PORT` > this > 3000. */
  port?: number
  /** Listen host / bind address. Default: all interfaces. Containers behind a
   *  proxy typically need `0.0.0.0`. */
  host?: string
  /** Canonical app URL (`https://example.com`) — for absolute-URL generation
   *  (redirects, SSE reconnect, OG tags) and as a spoof-proof same-origin
   *  anchor. Exposed to middleware via `stator(c).origin`. */
  origin?: string
  /** Signing secret for signed cookies (`cookies.setSigned`/`getSigned`) — the
   *  sealed short-lived-state primitive (OAuth `state`/PKCE, a magic-link token,
   *  a WebAuthn challenge). Falls back to `process.env.STATOR_SECRET`. Use a long
   *  random string (≥32 chars); keep it out of source — set it in `.env.local` or
   *  a platform secret. Absent → the signed-cookie methods throw. */
  secret?: string
  /** The swappable persistence adapters, grouped by concern. Both optional —
   *  default to in-memory (restart-wipe). Neither is a machine-graph entry
   *  point (machines are file-discovered). */
  persistence?: {
    /** Session-lifecycle machine state. Default: `InMemoryStore`. Pass a
     *  `RedisStore`/`CachedStore` for durability — the adapter seam. */
    session?: Store
    /** App-lifecycle machine state for `persist: true` machines (no TTL, one
     *  blob per machine). Advanced — most apps never set it. Default:
     *  in-memory (restart-wipe). Pass a `RedisAppStore` for durable app state. */
    app?: AppStore
  }
  /** Session policy (no adapter here — that lives in `persistence.session`). */
  sessions?: {
    /** Per-session idle TTL in seconds. Default: 86400 (24h). */
    ttlSeconds?: number
    /** Session cookie policy. */
    cookie?: {
      /** `SameSite` attribute. Default `Lax` (allows same-site subdomains).
       *  `Strict` withholds the cookie from every cross-site request and flips
       *  the CSRF guard to allowlist-only — the controlled posture. */
      sameSite?: 'Lax' | 'Strict'
    }
    // cookieName?, rotation? — reserved policy siblings (not wired yet).
  }
  /** Realtime / push policy. Protocol-neutral so a future WS transport doesn't
   *  make the key a lie. */
  realtime?: {
    /** SSE heartbeat interval in ms (`start` only). Default: 25000. */
    pingMs?: number
    // transport? — reserved INTERNAL seam (not user-facing).
  }
  /** Dev-only tooling. */
  dev?: {
    /** Dev inspector toolbar (`dev` only). Default: on. */
    inspector?: boolean
  }
  /** Origins allowed to make cross-site writes despite the CSRF guard — exact
   *  (`https://app.example.com`) or wildcard-subdomain (`https://*.example.com`).
   *  Same-origin and same-site writes are already allowed; this is for decoupled
   *  frontends or partner domains. */
  trustedOrigins?: string[]
  /** Cross-origin READ policy (CORS) — governs which cross-origin sites may read
   *  responses (distinct from `trustedOrigins`, which governs cross-site writes).
   *  Opt in per route/app with the `cors()` middleware; `origins` defaults to
   *  `trustedOrigins`. */
  cors?: { origins?: string[]; credentials?: boolean }
  /** Logging policy. */
  logging?: {
    /** Minimum level to emit. Default: `warn` in production, `info` in dev.
     *  Precedence: `LOG_LEVEL` env > this > default. */
    level?: LogLevel
  }
  /** Image serving. Present → the framework mounts an image endpoint over
   *  `dir` (originals + on-demand variants: the URL's extension is the
   *  delivery format, `?w=` resizes from the allowlist). Absent → no routes,
   *  no transformer loaded — image-free apps pay nothing. */
  images?: {
    /** Directory holding the original images (dated subpaths welcome) —
     *  runtime-written data like a SQLite file, NOT under `static/` (builds
     *  recreate `dist/static`). Relative paths resolve against the cwd. */
    dir: string
    /** URL prefix the endpoint serves under. Default: `/<basename(dir)>`
     *  (`dir: 'media'` → `/media`). */
    path?: string
    /** The `?w=` allowlist, and the default `srcset` widths `getImage`
     *  emits. An allowlist because an open resize parameter is a
     *  denial-of-service invitation. Default: `[400, 800, 1200, 1600]`. */
    widths?: number[]
    /** Swap the transformer (default: sharp). See `ImageTransformer`. */
    transformer?: import('./server/images.ts').ImageTransformer
  }
  // observers?: Observer[] — top-level when the observability spec lands.
}

/** Identity helper for a typed config: `export default defineConfig({ … })`. */
export function defineConfig(config: StatorConfig): StatorConfig {
  return config
}
