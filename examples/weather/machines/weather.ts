import { defineMachine } from '@statorjs/stator/machine'
import { type Place, placeId } from '../lib/open-meteo.ts'
import SearchMachine from './search.ts'

/**
 * The DOMAIN machine: which places this session tracks and which is active.
 * It owns no forecast data and no clock — data lives in the shared
 * `ForecastCache` (app lifecycle, one copy per process), and refresh cadence
 * lives on the CLIENT (`refresh-clock` island). What this machine contributes
 * to the refresh path is the EMIT: `REVALIDATE` (from the app bar or the tick
 * island) re-emits the session's places as `REFRESH_REQUESTED`, which the
 * cache subscribes to — the only road a client has to an app machine.
 *
 * Coordinates never come from the wire. A browser picks a search result by
 * its position (`SearchMachine`'s `PICK`); the place itself, with the
 * coordinates the server will fetch, comes from the geocoder's results held
 * in that machine and arrives here as `ADD_PLACE`, which is `serverOnly`.
 *
 * Display state (tile VMs) lives in `PanelsMachine`, which reads this
 * machine, the settings and the cache — the read/write split that also keeps
 * the machine module graph acyclic.
 */

export interface SavedPlace extends Place {
  id: string
}

export const DEFAULT_PLACES: SavedPlace[] = (
  [
    { name: 'London', admin: 'England', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lon: -0.1278, timezone: 'Europe/London' },
    { name: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lon: 139.6503, timezone: 'Asia/Tokyo' },
    { name: 'New York', admin: 'New York', country: 'United States', countryCode: 'US', lat: 40.7128, lon: -74.006, timezone: 'America/New_York' },
  ] as Place[]
).map((p) => ({ ...p, id: placeId(p) }))

/** A session's list is bounded, so the cache it feeds is too. */
export const MAX_PLACES = 12

interface Ctx {
  places: SavedPlace[]
  activeId: string
}

type Events =
  | { type: 'ADD_PLACE'; place: Place }
  | { type: 'REMOVE_PLACE'; id: string }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'REVALIDATE' }

export default defineMachine({
  name: 'WeatherMachine',
  lifecycle: 'session',
  events: {} as Events,
  // Only the subscription below delivers this; a browser may not send it.
  serverOnly: ['ADD_PLACE'],
  subscribes: [{ from: SearchMachine, event: 'PICKED', dispatch: 'ADD_PLACE' }],
  emits: {
    // Ask the shared cache for fresh data on this session's places. The cache
    // applies the policy (staleness guard) — emitting is always safe.
    REFRESH_REQUESTED: {
      payload: (ctx: Ctx) => ({
        places: ctx.places.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon })),
      }),
    },
  },
  context: {
    places: DEFAULT_PLACES,
    activeId: DEFAULT_PLACES[0]!.id,
  } as Ctx,
  initial: 'ready',
  states: {
    ready: {
      on: {
        REVALIDATE: { emit: 'REFRESH_REQUESTED' },
        SET_ACTIVE: {
          do: (ctx, ev) => {
            if (ctx.places.some((p) => p.id === ev.id)) ctx.activeId = ev.id
          },
        },
        ADD_PLACE: {
          do: (ctx, ev) => {
            const id = placeId(ev.place)
            if (!ctx.places.some((p) => p.id === id)) {
              if (ctx.places.length >= MAX_PLACES) return
              ctx.places.push({ ...ev.place, id })
            }
            ctx.activeId = id
          },
          // The refresh emit covers the newcomer: every other place is fresh,
          // so the cache's guard reduces this to exactly one fetch.
          emit: 'REFRESH_REQUESTED',
        },
        REMOVE_PLACE: {
          do: (ctx, ev) => {
            if (ctx.places.length <= 1) return // always keep at least one
            ctx.places = ctx.places.filter((p) => p.id !== ev.id)
            if (ctx.activeId === ev.id) ctx.activeId = ctx.places[0]!.id
          },
        },
      },
    },
  },
  selectors: {
    places: (ctx) => ctx.places,
    activeId: (ctx) => ctx.activeId,
    active: (ctx) => ctx.places.find((p) => p.id === ctx.activeId) ?? ctx.places[0] ?? null,
  },
})
