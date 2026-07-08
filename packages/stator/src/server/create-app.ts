import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import type { AppStore } from './app-store.ts'
import { discoverMachines } from './discovery.ts'
import { wireAppEffects } from './effects.ts'
import { buildHonoApp } from './http.ts'
import { logger } from './logger.ts'
import { MachineStore } from './machine-store.ts'
import { discoverRoutes } from './route-discovery.ts'
import { InMemoryStore, type Store } from './store.ts'

export interface CreateAppConfig {
  machinesDir: string
  routesDir: string
  staticDir?: string
  /** Persistence adapter for session-lifecycle machine state. Defaults to
   *  InMemoryStore — fine for dev, V1 adapters swap in here. */
  store?: Store
  /** Persistence for `persist: true` app-lifecycle machines (no TTL, one
   *  blob per machine). Defaults to in-memory (restart-wipe); pass
   *  RedisAppStore for durable app state. */
  appStore?: AppStore
  /** Per-session TTL in seconds. Every set to any of the session's
   *  machines refreshes this expiry. Defaults to 24h (86400). */
  sessionTtlSeconds?: number
  /** Extra `<head>` HTML per GET route. A production build uses this to link the
   *  prebuilt `components.css`; ignored if omitted. */
  headExtras?: (filePath: string) => string | Promise<string>
  /** Serve + inject the wire inspector toolbar (the dev server's on by
   *  default; production opts in — demo sites want the wire visible). */
  inspector?: boolean
}

export interface StatorApp {
  listen(port: number): Promise<void>
  /** For tests — get the underlying Hono fetch handler. */
  fetch: (request: Request) => Response | Promise<Response>
  /** The machine registry + app actors — pass to `dispatchToApp` for
   *  server-originated events (webhooks, cron). */
  store: MachineStore
}

export async function createApp(config: CreateAppConfig): Promise<StatorApp> {
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined

  const { defs } = await discoverMachines(machinesDir)
  const persistence = config.store ?? new InMemoryStore()
  const store = new MachineStore(defs, persistence, {
    sessionTtlSeconds: config.sessionTtlSeconds,
    appStore: config.appStore,
  })
  await store.bootAppMachines()
  wireAppEffects(store)

  const routes = await discoverRoutes(routesDir)
  const app = await buildHonoApp({
    routes,
    store,
    staticDir,
    headExtras: config.inspector
      ? async (filePath) => {
          const base = (await config.headExtras?.(filePath)) ?? ''
          return `${base}\n<script src="/@stator/inspector.js" defer></script>`
        }
      : config.headExtras,
    inspector: config.inspector,
  })

  return {
    listen(port: number): Promise<void> {
      return new Promise((resolveFn) => {
        serve({ fetch: app.fetch, port }, () => {
          logger.info({ port, machines: defs.length, routes: routes.length }, 'listening')
          resolveFn()
        })
      })
    },
    fetch: (request: Request) => app.fetch(request),
    store,
  }
}
