import type { Hono } from 'hono'
import type { ViteDevServer } from 'vite'
import type { LogLevel } from '../config.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import type { AppStore } from './app-store.ts'
import { createNativeDevApp as createNative, type NativeDevApp } from './dev-native.ts'
import type { Store } from './store.ts'

/**
 * The dev entry. `createDevApp` boots the NATIVE dev server (`dev-native.ts`):
 * the app runs from its source tree under Node's module loader exactly as
 * `stator start` runs a build — no Vite in the server path, no dev/prod
 * divergence, truthful `import.meta.url`s.
 *
 * `STATOR_VITE_DEV=1` keeps the previous Vite-embedded dev server
 * (`dev-vite.ts`) for one minor as an escape hatch while the native loop beds
 * in. It is loaded lazily, so the default path never imports Vite.
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
    transformer?: import('./images.ts').ImageTransformer
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
  // Deprecated flat keys — accepted (typed) so 2.1.0 callers don't break; nested
  // wins. `createDevApp` never shipped `ssePingMs`, so it's not accepted here.
  /** @deprecated use `persistence.session` */
  store?: Store
  /** @deprecated use `persistence.app` */
  appStore?: AppStore
  /** @deprecated use `sessions.ttlSeconds` */
  sessionTtlSeconds?: number
  /** @deprecated use `dev.inspector` */
  inspector?: boolean
}

export interface DevApp {
  fetch: (request: Request) => Response | Promise<Response>
  /** @deprecated The dev server no longer embeds Vite — this is `undefined`
   *  (with a one-time warning) and will be removed in the next major. Under the
   *  transitional `STATOR_VITE_DEV=1` escape hatch it is still the real
   *  `ViteDevServer` for one minor. */
  readonly vite: ViteDevServer | undefined
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
  listen: (port: number) => Promise<void>
  close: () => Promise<void>
}

let warnedVite = false
/** The native app in the public `DevApp` shape: `vite` is a deprecated getter
 *  that warns once and returns `undefined`. Exported for tests. */
export function withDeprecatedVite(app: NativeDevApp): DevApp {
  return {
    fetch: (request) => app.fetch(request),
    get hono() {
      return app.hono
    },
    dispatchToApp: (machine, event) => app.dispatchToApp(machine, event),
    listen: (port) => app.listen(port),
    close: () => app.close(),
    get vite(): undefined {
      if (!warnedVite) {
        warnedVite = true
        console.warn(
          'stator: DevApp.vite is deprecated and returns undefined — the dev server no ' +
            'longer embeds Vite. STATOR_VITE_DEV=1 keeps the Vite dev server for one minor.',
        )
      }
      return undefined
    },
  }
}

export async function createDevApp(config: DevAppConfig): Promise<DevApp> {
  if (process.env.STATOR_VITE_DEV === '1') {
    const { createViteDevApp } = await import('./dev-vite.ts')
    return createViteDevApp(config)
  }
  return withDeprecatedVite(await createNative(config))
}

/** @deprecated `createDevApp` IS the native dev server now — use it. (This
 *  alias always boots the native server, ignoring `STATOR_VITE_DEV`.) */
export const createNativeDevApp = async (config: DevAppConfig): Promise<DevApp> =>
  withDeprecatedVite(await createNative(config))

export type { NativeDevApp } from './dev-native.ts'
