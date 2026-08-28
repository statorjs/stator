import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import type { LogLevel } from '../config.ts'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import type { AppStore } from './app-store.ts'
import { installGracefulShutdown, printStartupNotice } from './banner.ts'
import { type BootTeardown, discoverBoot, runBoot } from './boot.ts'
import { type DeprecatedFlatConfig, resolveAppConfig } from './config-compat.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { loadDotenv } from './env.ts'
import { buildHonoApp } from './http.ts'
import { type ImageTransformer, resolveImagesConfig } from './images.ts'
import { logger, setLogLevel } from './logger.ts'
import { MachineStore } from './machine-store.ts'
import { discoverMiddleware } from './middleware.ts'
import { discoverRoutes } from './route-discovery.ts'
import { setSessionSameSite } from './session.ts'
import { InMemoryStore, type Store } from './store.ts'

export interface CreateAppConfig extends DeprecatedFlatConfig {
  machinesDir: string
  routesDir: string
  staticDir?: string
  /** Swappable persistence adapters, grouped by concern. Both optional —
   *  default to in-memory (restart-wipe). Mirrors `StatorConfig.persistence`. */
  persistence?: {
    /** Session-lifecycle machine state. Defaults to InMemoryStore — fine for
     *  dev, V1 adapters swap in here. */
    session?: Store
    /** App-lifecycle machine state for `persist: true` machines (no TTL, one
     *  blob per machine). Defaults to in-memory (restart-wipe); pass
     *  RedisAppStore for durable app state. */
    app?: AppStore
  }
  /** Session policy. */
  sessions?: {
    /** Per-session TTL in seconds. Every set to any of the session's machines
     *  refreshes this expiry. Defaults to 24h (86400). */
    ttlSeconds?: number
    /** Session cookie policy. `cookie.sameSite: 'Strict'` opts into the
     *  controlled CSRF posture. */
    cookie?: { sameSite?: 'Lax' | 'Strict' }
  }
  /** Realtime / push policy. */
  realtime?: {
    /** SSE heartbeat interval in ms (default 25s). Tests shorten it. */
    pingMs?: number
  }
  /** Dev-only tooling. */
  dev?: {
    /** Serve + inject the wire inspector toolbar (the dev server's on by
     *  default; production opts in — demo sites want the wire visible). */
    inspector?: boolean
  }
  /** Logging policy. */
  logging?: {
    /** Minimum level to emit. Default: `warn` in production, `info` in dev.
     *  `LOG_LEVEL` env takes precedence over this. */
    level?: LogLevel
  }
  /** Image serving — present mounts the image endpoint over `images.dir`
   *  (extension = delivery format, `?w=` allowlist, disk-cached variants).
   *  Absent → no routes, no transformer loaded. Mirrors `StatorConfig.images`. */
  images?: {
    dir: string
    path?: string
    widths?: number[]
    aspectRatios?: number[]
    transformer?: ImageTransformer
  }
  /** Origins allowed to make cross-site writes despite the CSRF guard (exact or
   *  wildcard-subdomain). Mirrors `StatorConfig.trustedOrigins`. */
  trustedOrigins?: readonly string[]
  /** Canonical app URL, exposed via `stator(c).origin`. */
  origin?: string
  /** Signed-cookie signing key. Falls back to `STATOR_SECRET`. Mirrors
   *  `StatorConfig.secret`. */
  secret?: string
  /** Listen host / bind address (used by `listen`). Default: all interfaces. */
  host?: string
  /** Cross-origin READ policy (CORS); `origins` defaults to `trustedOrigins`. */
  cors?: { origins?: string[]; credentials?: boolean }
  /** Extra `<head>` HTML per GET route. A production build uses this to link the
   *  prebuilt `components.css`; ignored if omitted. */
  headExtras?: (filePath: string) => string | Promise<string>
  /** Path to the app's `middleware.ts` (if any). Loaded and validated; its
   *  default export must be `defineMiddleware`/`dangerouslyDefineMiddleware`. */
  middlewareFile?: string
  /** Path to the app's `boot.ts` (if any). Its default export must be
   *  `defineBoot(...)`; it runs once when the app starts listening. */
  bootFile?: string
  /** Build identifier for the deploy-aware reload handshake. `stator start`
   *  passes the id baked into the build manifest; absent → no handshake. */
  buildId?: string
  /** Machine code hashes from the build manifest (`loadProductionHead(dist).machines`),
   *  keyed by file relative to `machinesDir`. Omitted ⇒ hashed live at boot;
   *  a discovered machine missing from a supplied map is a boot error. */
  machineHashes?: Readonly<Record<string, string>>
}

export interface StatorApp {
  listen(port: number): Promise<void>
  /** For tests — get the underlying Hono fetch handler. */
  fetch: (request: Request) => Response | Promise<Response>
  /** The machine registry + app actors. Kept exposed for advanced use;
   *  prefer the `dispatchToApp` method for server-originated events. */
  store: MachineStore
  /** Server-originated dispatch to an APP-lifecycle machine — the entry
   *  point for webhooks and cron. Same contract as the standalone
   *  `dispatchToApp(store, …)`, bound to this app's store. */
  dispatchToApp<D extends AnyMachineDef>(
    machine: D,
    event: EventOf<D>,
  ): Promise<{ committed: boolean }>
  /** Break-glass: the raw Hono app. The unsupported paved-road exit — for
   *  sub-app mounts / protocol upgrades the framework surface doesn't cover.
   *  Mutate before `listen`. */
  hono: Hono
}

export async function createApp(config: CreateAppConfig): Promise<StatorApp> {
  // Load .env before anything reads process.env (LOG_LEVEL below, app secrets).
  // No-op if the CLI already loaded it; covers the direct `server.ts` entry.
  loadDotenv()
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined

  const resolved = resolveAppConfig(config)
  // Level precedence: LOG_LEVEL env > config > the production default (createApp
  // is the production entry point, so it defaults quiet). setLogLevel also covers
  // the scoped children (http/sse/…), which a bare `logger.level =` would miss.
  setLogLevel(process.env.LOG_LEVEL ?? resolved.logLevel ?? 'warn')
  setSessionSameSite(resolved.sameSite ?? 'Lax')
  const { defs } = await discoverMachines(machinesDir, undefined, {
    ...(config.machineHashes ? { hashes: config.machineHashes } : {}),
  })
  const sessionStore = resolved.session ?? new InMemoryStore()
  const store = new MachineStore(defs, sessionStore, {
    sessionTtlSeconds: resolved.sessionTtlSeconds,
    appStore: resolved.app,
  })
  // Wire the effect scheduler BEFORE booting: a fresh app machine fires its
  // initial-state entry effect during boot, and that must have somewhere to go.
  wireAppEffects(store)
  await store.bootAppMachines()

  const routes = await discoverRoutes(routesDir)
  const middleware = config.middlewareFile
    ? await discoverMiddleware(config.middlewareFile)
    : undefined
  const bootDef = config.bootFile ? await discoverBoot(config.bootFile) : undefined
  const inspector = resolved.inspector
  const images = config.images ? resolveImagesConfig(config.images) : undefined
  const app = await buildHonoApp({
    images,
    routes,
    store,
    staticDir,
    headExtras: inspector
      ? async (filePath) => {
          const base = (await config.headExtras?.(filePath)) ?? ''
          return `${base}\n<script src="/@stator/inspector.js" defer></script>`
        }
      : config.headExtras,
    inspector,
    ssePingMs: resolved.ssePingMs,
    trustedOrigins: resolved.trustedOrigins,
    sameSite: resolved.sameSite,
    origin: resolved.origin,
    secret: resolved.secret,
    buildId: config.buildId,
    cors: resolved.cors,
    middleware,
  })

  return {
    listen(port: number): Promise<void> {
      return new Promise((resolveFn) => {
        const server = serve({ fetch: app.fetch, port, hostname: resolved.host }, async () => {
          // Always-on (level-independent) so `warn` prod still confirms boot.
          printStartupNotice({ port, machines: defs.length, routes: routes.length })
          // Run boot.ts once the server is up — its long-lived work (a poll, a
          // subscription) starts here, not during createApp, so tests that only
          // `app.fetch` never trigger it.
          const teardown: BootTeardown | undefined = await runBoot(bootDef, {
            dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
            config: {
              origin: resolved.origin,
              trustedOrigins: resolved.trustedOrigins ?? [],
              sameSite: resolved.sameSite ?? 'Lax',
              cors: resolved.cors,
            },
          })
          // Ctrl+C / SIGTERM (deploy rollover) exits 0, not 130 — quiet in prod.
          // Boot teardown runs first (unsubscribe/clear timers), then the server.
          installGracefulShutdown(async () => {
            if (teardown) await teardown()
            await new Promise<void>((done) => server.close(() => done()))
          }, true)
          resolveFn()
        })
        // Production is strict about its port (a collision is a deploy
        // error) — but says so in one line, not a stack trace.
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            logger.error(
              { port },
              `port ${port} is already in use — is another instance running? (set PORT to change it)`,
            )
            process.exit(1)
          }
          throw err
        })
      })
    },
    fetch: (request: Request) => app.fetch(request),
    store,
    dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
    hono: app,
  }
}
