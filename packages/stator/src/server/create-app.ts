import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import type { AppStore } from './app-store.ts'
import { installGracefulShutdown } from './banner.ts'
import { type DeprecatedFlatConfig, resolveAppConfig } from './config-compat.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { buildHonoApp } from './http.ts'
import { logger } from './logger.ts'
import { MachineStore } from './machine-store.ts'
import { discoverRoutes } from './route-discovery.ts'
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
  /** Extra `<head>` HTML per GET route. A production build uses this to link the
   *  prebuilt `components.css`; ignored if omitted. */
  headExtras?: (filePath: string) => string | Promise<string>
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
}

export async function createApp(config: CreateAppConfig): Promise<StatorApp> {
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined

  const resolved = resolveAppConfig(config)
  const { defs } = await discoverMachines(machinesDir)
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
  const inspector = resolved.inspector
  const app = await buildHonoApp({
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
  })

  return {
    listen(port: number): Promise<void> {
      return new Promise((resolveFn) => {
        const server = serve({ fetch: app.fetch, port }, () => {
          logger.info({ port, machines: defs.length, routes: routes.length }, 'listening')
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
        // Ctrl+C / SIGTERM (deploy rollover) exits 0, not 130 — quiet in
        // prod: the structured logs are the record.
        installGracefulShutdown(() => new Promise<void>((done) => server.close(() => done())), true)
      })
    },
    fetch: (request: Request) => app.fetch(request),
    store,
    dispatchToApp: (machine, event) => dispatchToApp(store, machine, event),
  }
}
