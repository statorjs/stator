/**
 * Dev state inspection — the data feed for the inspector's Machines view.
 *
 * Serves the caller's OWN session: the payload is scoped to the session the
 * request's cookie addresses (app-lifecycle machines are process-global and
 * labeled as such by their lifecycle). Registered only by the dev servers —
 * machine context is working state and may hold anything, so this endpoint
 * never exists in production.
 *
 * Read-only by construction: no actors are instantiated, no session lock is
 * taken, nothing is dispatched. Session snapshots come straight from the
 * persistence store — a machine never touched by this session reads as null
 * (it would start from the def's initial context on first dispatch).
 */

import { describeMachine, type MachineDescription } from '../engine/describe.ts'
import type { Snapshot } from '../engine/types.ts'
import { codeHashOf } from './machine-hash.ts'
import type { MachineStore } from './machine-store.ts'
import { type DiscoveredRoute, HTTP_METHODS } from './route-discovery.ts'
import { isStatorQueryRoute, isStatorRoute } from './routing.ts'

export interface InspectRouteMethod {
  /** `page` = defineRoute, `data` = defineApiRoute({method:'GET'}), `api` = the rest. */
  kind: 'page' | 'data' | 'api'
  reads: string[]
  /** Page routes only: whether the route opened an SSE live channel. */
  live?: boolean
}

export interface InspectRoute {
  urlPath: string
  methods: Record<string, InspectRouteMethod>
}

export interface InspectPayload {
  buildId?: string
  /** All registered machines, described + their running code hash. */
  machines: Array<MachineDescription & { hash?: string }>
  /** The caller's session's persisted snapshots (null = never touched). */
  session: Record<string, Snapshot<unknown> | null>
  /** App-lifecycle live snapshots — process-global, same for every caller. */
  app: Record<string, Snapshot<unknown>>
  routes: InspectRoute[]
}

export async function buildInspectPayload(opts: {
  store: MachineStore
  routes: DiscoveredRoute[]
  sessionId?: string
  buildId?: string
}): Promise<InspectPayload> {
  const defs = [...opts.store.allDefs()].sort((a, b) => a.name.localeCompare(b.name))

  const machines = defs.map((def) => {
    const hash = codeHashOf(def)
    return { ...describeMachine(def), ...(hash !== undefined ? { hash } : {}) }
  })

  const session: Record<string, Snapshot<unknown> | null> = {}
  if (opts.sessionId !== undefined) {
    for (const def of defs) {
      if (def.lifecycle !== 'session') continue
      session[def.name] =
        ((await opts.store.persistence.get(
          opts.sessionId,
          def.name,
        )) as Snapshot<unknown> | null) ?? null
    }
  }

  const app: Record<string, Snapshot<unknown>> = {}
  for (const def of defs) {
    if (def.lifecycle !== 'app') continue
    const handle = opts.store.appInstance(def.name)
    if (handle) app[def.name] = handle.actor.getSnapshot()
  }

  const routes = opts.routes.map((route): InspectRoute => {
    const methods: Record<string, InspectRouteMethod> = {}
    for (const method of HTTP_METHODS) {
      const def = route[method]
      if (!def) continue
      const reads = def.reads.map((d) => d.name)
      if (isStatorRoute(def)) {
        methods[method] = { kind: 'page', reads, live: def.live }
      } else {
        methods[method] = { kind: isStatorQueryRoute(def) ? 'data' : 'api', reads }
      }
    }
    return { urlPath: route.urlPath, methods }
  })

  return {
    ...(opts.buildId !== undefined ? { buildId: opts.buildId } : {}),
    machines,
    session,
    app,
    routes,
  }
}
