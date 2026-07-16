import { defineMachine } from '@statorjs/stator/server'
import {
  type AirQuality,
  type Current,
  fetchAirQuality,
  fetchForecast,
  type Forecast,
  type Place,
  placeId,
} from '../lib/open-meteo.ts'
import SettingsMachine, { type Clock, type Units } from './settings.ts'

/**
 * Multi-location weather, exercising the whole effect model in one machine:
 *   - `loading.entry`  — loads every saved place in parallel on first paint,
 *   - `after`          — revalidates them all on a cadence (wall-clock, no request),
 *   - `ADD_PLACE` effect — fetches JUST the new place, keeping the others live.
 *
 * It also `subscribes` to `SettingsMachine.CHANGED` and mirrors `units`/`clock`
 * into its own context, so the formatting selectors re-render when the user
 * toggles units — live, and across tabs.
 */

interface SavedPlace extends Place {
  id: string
}

interface PlaceData {
  status: 'loading' | 'ready' | 'error'
  forecast: Forecast | null
  aqi: AirQuality | null
  updatedAt: number | null
}

const REVALIDATE_MS = 15 * 60_000

const DEFAULT_PLACES: SavedPlace[] = (
  [
    { name: 'London', admin: 'England', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lon: -0.1278, timezone: 'Europe/London' },
    { name: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lon: 139.6503, timezone: 'Asia/Tokyo' },
    { name: 'New York', admin: 'New York', country: 'United States', countryCode: 'US', lat: 40.7128, lon: -74.006, timezone: 'America/New_York' },
  ] as Place[]
).map((p) => ({ ...p, id: placeId(p) }))

interface Ctx {
  places: SavedPlace[]
  activeId: string
  data: Record<string, PlaceData>
  units: Units
  clock: Clock
}

type LoadResult =
  | { id: string; forecast: Forecast; aqi: AirQuality | null }
  | { id: string; failed: true }

type Events =
  | { type: 'LOADED_ALL'; results: LoadResult[] }
  | { type: 'PLACE_LOADED'; id: string; forecast: Forecast; aqi: AirQuality | null }
  | { type: 'PLACE_FAILED'; id: string }
  | { type: 'ADD_PLACE'; place: Place }
  | { type: 'REMOVE_PLACE'; id: string }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'REVALIDATE' }
  | { type: 'SETTINGS_CHANGED'; units: Units; clock: Clock; sourceSessionId?: string }

async function loadOne(p: {
  lat: number
  lon: number
}): Promise<{ forecast: Forecast; aqi: AirQuality | null }> {
  const [forecast, aqi] = await Promise.all([
    fetchForecast(p.lat, p.lon),
    fetchAirQuality(p.lat, p.lon).catch(() => null), // AQI is best-effort
  ])
  return { forecast, aqi }
}

async function loadAll(places: SavedPlace[]): Promise<Events> {
  const results = await Promise.all(
    places.map(async (p): Promise<LoadResult> => {
      try {
        const { forecast, aqi } = await loadOne(p)
        return { id: p.id, forecast, aqi }
      } catch {
        return { id: p.id, failed: true }
      }
    }),
  )
  return { type: 'LOADED_ALL', results }
}

const applyLoadedAll = (ctx: Ctx, ev: { results: LoadResult[] }): void => {
  for (const r of ev.results) {
    ctx.data[r.id] =
      'failed' in r
        ? { status: 'error', forecast: null, aqi: null, updatedAt: null }
        : { status: 'ready', forecast: r.forecast, aqi: r.aqi, updatedAt: Date.now() }
  }
}

const mirrorSettings = (ctx: Ctx, ev: { units: Units; clock: Clock }): void => {
  ctx.units = ev.units
  ctx.clock = ev.clock
}

const fmtTemp = (t: number | null | undefined, units: Units): string => {
  if (t == null) return '—'
  return units === 'imperial' ? `${Math.round(t * (9 / 5) + 32)}°` : `${Math.round(t)}°`
}

export default defineMachine({
  name: 'WeatherMachine',
  lifecycle: 'session',
  events: {} as Events,
  // Mirror display prefs from the Settings machine so our formatting selectors
  // re-render when units/clock change.
  subscribes: [{ from: SettingsMachine, event: 'CHANGED', dispatch: 'SETTINGS_CHANGED' }],
  context: {
    places: DEFAULT_PLACES,
    activeId: DEFAULT_PLACES[0]!.id,
    data: {},
    units: 'metric',
    clock: '24h',
  } as Ctx,
  initial: 'loading',
  states: {
    loading: {
      entry: async (ctx): Promise<Events | null> => loadAll(ctx.places),
      on: {
        LOADED_ALL: { to: 'ready', do: applyLoadedAll },
        SETTINGS_CHANGED: { do: mirrorSettings },
      },
    },
    ready: {
      after: [{ delay: REVALIDATE_MS, send: { type: 'REVALIDATE' } }],
      on: {
        REVALIDATE: { to: 'revalidating' },
        SETTINGS_CHANGED: { do: mirrorSettings },
        SET_ACTIVE: {
          do: (ctx, ev) => {
            if (ctx.places.some((p) => p.id === ev.id)) ctx.activeId = ev.id
          },
        },
        ADD_PLACE: {
          do: (ctx, ev) => {
            const id = placeId(ev.place)
            if (!ctx.places.some((p) => p.id === id)) {
              ctx.places.push({ ...ev.place, id })
              ctx.data[id] = { status: 'loading', forecast: null, aqi: null, updatedAt: null }
            }
            ctx.activeId = id
          },
          // Transition effect: fetch only the newly-added place.
          effect: async (_ctx, ev): Promise<Events | null> => {
            const id = placeId(ev.place)
            try {
              const { forecast, aqi } = await loadOne(ev.place)
              return { type: 'PLACE_LOADED', id, forecast, aqi }
            } catch {
              return { type: 'PLACE_FAILED', id }
            }
          },
        },
        PLACE_LOADED: {
          do: (ctx, ev) => {
            ctx.data[ev.id] = {
              status: 'ready',
              forecast: ev.forecast,
              aqi: ev.aqi,
              updatedAt: Date.now(),
            }
          },
        },
        PLACE_FAILED: {
          do: (ctx, ev) => {
            const d = ctx.data[ev.id]
            if (d) d.status = 'error'
          },
        },
        REMOVE_PLACE: {
          do: (ctx, ev) => {
            if (ctx.places.length <= 1) return // always keep at least one
            ctx.places = ctx.places.filter((p) => p.id !== ev.id)
            delete ctx.data[ev.id]
            if (ctx.activeId === ev.id) ctx.activeId = ctx.places[0]!.id
          },
        },
      },
    },
    revalidating: {
      // status stays 'ready' for each place, so pages keep showing data.
      entry: async (ctx): Promise<Events | null> => loadAll(ctx.places),
      on: {
        LOADED_ALL: { to: 'ready', do: applyLoadedAll },
        SETTINGS_CHANGED: { do: mirrorSettings },
      },
    },
  },
  selectors: {
    places: (ctx) => ctx.places,
    activeId: (ctx) => ctx.activeId,
    active: (ctx) => ctx.places.find((p) => p.id === ctx.activeId) ?? ctx.places[0] ?? null,
    units: (ctx) => ctx.units,
    clock: (ctx) => ctx.clock,
    dataFor: (ctx) => (id: string): PlaceData | null => ctx.data[id] ?? null,
    activeStatus: (ctx) => ctx.data[ctx.activeId]?.status ?? 'loading',
    activeCurrent: (ctx): Current | null => ctx.data[ctx.activeId]?.forecast?.current ?? null,
    /** Temperature in the chosen unit — a single binding that re-renders on both
     *  a weather refresh and a units toggle (units are mirrored into this ctx). */
    activeTempDisplay: (ctx) => fmtTemp(ctx.data[ctx.activeId]?.forecast?.current?.temp, ctx.units),
  },
})
