import { defineMachine } from '@statorjs/stator/server'
import { type AirQuality, fetchAirQuality, fetchForecast, type Forecast } from '../lib/open-meteo.ts'
import WeatherMachine from './weather.ts'

/**
 * Shared forecast data, cached ONCE for the whole process — every session
 * watching London reads the same entry, and a place nobody asks about is a
 * place never fetched.
 *
 * This machine owns no clock. Refresh cadence lives on the CLIENT (the
 * `refresh-clock` island ticks while a tab is visible — demand-aware by
 * construction: hidden tabs stop asking, closed tabs can't). What lives HERE
 * is the POLICY: the `REFRESH` guard drops requests whose places are all
 * fresh or already being fetched, so ten tabs ticking in the same window cost
 * one upstream fetch, and a spam-clicked refresh button costs nothing.
 *
 * Reactive read-through, not autonomous: no `after` loop means no polling for
 * abandoned sessions and nothing to stop — zero demand is simply the absence
 * of REFRESH events. Not persisted: cache, in-flight marks, and process die
 * together, and a restart refetches on the first tick.
 */

export interface PlaceData {
  status: 'ready' | 'error'
  forecast: Forecast | null
  aqi: AirQuality | null
  updatedAt: number
}

interface PlaceReq {
  id: string
  lat: number
  lon: number
}

interface Ctx {
  data: Record<string, PlaceData>
  /** Place ids with a fetch in flight — drives the app bar spinner (an APP
   *  machine's changes fan out to every connection, so all tabs of all
   *  sessions see a refresh happening, whoever asked for it). */
  fetching: string[]
}

type LoadResult = { id: string; forecast: Forecast; aqi: AirQuality | null } | { id: string; failed: true }

type Events =
  | { type: 'REFRESH'; places: PlaceReq[]; sourceSessionId?: string }
  | { type: 'LOADED'; results: LoadResult[] }

/** Server-side rate floor: a place fresher than this is never refetched, no
 *  matter how many clients ask. The clock is the client's; the policy is ours. */
const MIN_REFRESH_MS = 30_000

const staleRequested = (ctx: Ctx, places: PlaceReq[]): PlaceReq[] =>
  places.filter((p) => {
    if (ctx.fetching.includes(p.id)) return false // already on its way
    const cached = ctx.data[p.id]
    return !cached || Date.now() - cached.updatedAt > MIN_REFRESH_MS
  })

export default defineMachine({
  name: 'ForecastCache',
  lifecycle: 'app',
  events: {} as Events,
  // Sessions can't be dispatched around by clients directly, and clients
  // can't reach app machines at all — the refresh path is client → session
  // machine → emit → this subscription (sourceSessionId injected).
  subscribes: [{ from: WeatherMachine, event: 'REFRESH_REQUESTED', dispatch: 'REFRESH' }],
  context: { data: {}, fetching: [] } as Ctx,
  initial: 'watching',
  states: {
    watching: {
      on: {
        REFRESH: {
          // The policy gate: nothing stale and nothing new ⇒ the event is
          // dropped before it commits — no fan-out, no fetch, no cost.
          when: (ctx, ev) => staleRequested(ctx, ev.places).length > 0,
          do: (ctx, ev) => {
            for (const p of staleRequested(ctx, ev.places)) ctx.fetching.push(p.id)
          },
          // Command-role fetch: at-most-once is fine here — a fetch lost to a
          // crash is healed by the next client tick asking again.
          effect: async (ctx, ev): Promise<Events | null> => {
            const wanted = ev.places.filter((p) => ctx.fetching.includes(p.id))
            const results = await Promise.all(
              wanted.map(async (p): Promise<LoadResult> => {
                try {
                  const [forecast, aqi] = await Promise.all([
                    fetchForecast(p.lat, p.lon),
                    fetchAirQuality(p.lat, p.lon).catch(() => null), // AQI is best-effort
                  ])
                  return { id: p.id, forecast, aqi }
                } catch {
                  return { id: p.id, failed: true }
                }
              }),
            )
            return { type: 'LOADED', results }
          },
        },
        LOADED: {
          do: (ctx, ev) => {
            for (const r of ev.results) {
              ctx.data[r.id] =
                'failed' in r
                  ? { status: 'error', forecast: null, aqi: null, updatedAt: Date.now() }
                  : { status: 'ready', forecast: r.forecast, aqi: r.aqi, updatedAt: Date.now() }
              ctx.fetching = ctx.fetching.filter((id) => id !== r.id)
            }
          },
        },
      },
    },
  },
  selectors: {
    byId: (ctx) => (id: string): PlaceData | null => ctx.data[id] ?? null,
    fetchingIds: (ctx) => ctx.fetching,
  },
})
