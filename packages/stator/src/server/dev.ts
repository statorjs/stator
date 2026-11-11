import type { Hono } from 'hono'
import type { LogLevel } from '../config.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import type { AppStore } from './app-store.ts'
import { createNativeDevApp as createNative, type NativeDevApp } from './dev-native.ts'
import type { Store } from './store.ts'

/**
 * The dev entry. `createDevApp` boots the native dev server (`dev-native.ts`):
 * the app runs from its source tree under Node's module loader exactly as
 * `stator start` runs a build — no dev/prod divergence, truthful
 * `import.meta.url`s, and esbuild for the island bundles.
 */

export interface DevAppConfig {
  /** The app directory (must reach node_modules for resolution). */
  root: string
  machinesDir: string
  routesDir: string
  staticDir?: string
  /** Swappable persistence adapters, grouped by concern. Both optional —
   *  default to in-memory. Mirrors `StatorConfig.persistence`. */
  persistence?: {
    /** Session-lifecycle machine state. Defaults to InMemoryStore. */
    session?: Store
    /** App-lifecycle machine state for `persist: true` machines. Defaults to
     *  in-memory. */
    app?: AppStore
  }
  /** Session policy. */
  sessions?: {
    /** Per-session TTL in seconds. Defaults to 24h (86400). */
    ttlSeconds?: number
    /** Session cookie policy. `cookie.sameSite: 'Strict'` opts into the
     *  controlled CSRF posture. */
    cookie?: { sameSite?: 'Lax' | 'Strict' }
  }
  /** Dev-only tooling. */
  /** Image serving — mirrors `StatorConfig.images`. */
  images?: {
    dir: string
    path?: string
    widths?: number[]
    aspectRatios?: number[]
    transformer?: import('./images.ts').ImageTransformer
    concurrency?: number
    threads?: number
    encodeTimeoutMs?: number
    maxAge?: number
    staleWhileRevalidate?: number
    immutable?: boolean
  }
  dev?: {
    /** Auto-inject the dev inspector toolbar. On by default; set false to disable. */
    inspector?: boolean
  }
  /** Logging policy. */
  logging?: {
    /** Minimum level to emit. Default: `info` in dev. `LOG_LEVEL` env wins. */
    level?: LogLevel
  }
  /** Origins allowed to make cross-site writes despite the CSRF guard (exact or
   *  wildcard-subdomain). Mirrors `StatorConfig.trustedOrigins`. */
  trustedOrigins?: readonly string[]
  /** Canonical app URL, exposed via `stator(c).origin`. */
  origin?: string
  /** Signed-cookie signing key. Falls back to `STATOR_SECRET`. Mirrors
   *  `StatorConfig.secret`. */
  secret?: string
  /** Cross-origin READ policy (CORS); `origins` defaults to `trustedOrigins`. */
  cors?: { origins?: string[]; credentials?: boolean }
}

export interface DevApp {
  fetch: (request: Request) => Response | Promise<Response>
  /** Server-originated dispatch to an APP-lifecycle machine (webhooks, cron)
   *  — the dev counterpart of `StatorApp.dispatchToApp`. Closes over the
   *  current store, surviving machine-edit rebuilds, so SSE fan-out reaches
   *  live connections. */
  dispatchToApp<D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ): Promise<{ committed: boolean }>
  /** Break-glass: the current raw Hono app (a getter — the dev server rebuilds
   *  it on edits, so mount inside the pipeline, not post-hoc). */
  readonly hono: Hono
  /** Start serving. Resolves with the port bound: the first free one at or
   *  above `port`, or the one the OS chose for `listen(0)`. */
  listen: (port: number) => Promise<{ port: number }>
  close: () => Promise<void>
}

export async function createDevApp(config: DevAppConfig): Promise<DevApp> {
  const app: NativeDevApp = await createNative(config)
  return {
    fetch: (request) => app.fetch(request),
    get hono() {
      return app.hono
    },
    dispatchToApp: (machine, event) => app.dispatchToApp(machine, event),
    listen: (port) => app.listen(port),
    close: () => app.close(),
  }
}

export type { NativeDevApp } from './dev-native.ts'
