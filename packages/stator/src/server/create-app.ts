import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { discoverMachines } from './discovery.ts'
import { discoverRoutes } from './route-discovery.ts'
import { MachineStore } from './machine-store.ts'
import { buildHonoApp } from './http.ts'
import { InMemoryStore, type Store } from './store.ts'

export interface CreateAppConfig {
  machinesDir: string
  routesDir: string
  staticDir?: string
  /** Persistence adapter for session-lifecycle machine state. Defaults to
   *  InMemoryStore — fine for dev, V1 adapters swap in here. */
  store?: Store
}

export interface StatorApp {
  listen(port: number): Promise<void>
  /** For tests — get the underlying Hono fetch handler. */
  fetch: (request: Request) => Response | Promise<Response>
}

export async function createApp(config: CreateAppConfig): Promise<StatorApp> {
  const machinesDir = resolve(config.machinesDir)
  const routesDir = resolve(config.routesDir)
  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined

  const { defs } = await discoverMachines(machinesDir)
  const persistence = config.store ?? new InMemoryStore()
  const store = new MachineStore(defs, persistence)
  store.bootAppMachines()

  const routes = await discoverRoutes(routesDir)
  const app = await buildHonoApp({ routes, store, staticDir })

  return {
    listen(port: number): Promise<void> {
      return new Promise((resolveFn) => {
        serve({ fetch: app.fetch, port }, () => {
          console.log(`stator: listening on http://localhost:${port}`)
          resolveFn()
        })
      })
    },
    fetch: (request: Request) => app.fetch(request),
  }
}
