import { defineMachine } from '@statorjs/stator/server'
import {
  type AirQuality,
  fetchAirQuality,
  fetchForecast,
  type Forecast,
  type Place,
} from '../lib/open-meteo.ts'

/**
 * The reactive-load pattern, end to end: `loading.entry` fetches from Open-Meteo,
 * `ready` serves it, and `after` revalidates on a cadence — all streamed live to
 * open pages over SSE. A `SET_LOCATION` (from the search box) re-enters `loading`,
 * which re-fires the entry effect for the new place. This is per-session state
 * (each visitor has their own location), so it's a `session` machine.
 */

const DEFAULT_PLACE: Place = {
  name: 'London',
  admin: 'England',
  country: 'United Kingdom',
  countryCode: 'GB',
  lat: 51.5074,
  lon: -0.1278,
  timezone: 'Europe/London',
}

const REVALIDATE_MS = 15 * 60_000 // refresh conditions every 15 min
const RETRY_MS = 30_000 // back off, then retry after a failure

type Status = 'loading' | 'ready' | 'error'

interface Ctx {
  place: Place
  forecast: Forecast | null
  aqi: AirQuality | null
  status: Status
  updatedAt: number | null
}

type Events =
  | { type: 'SET_LOCATION'; place: Place }
  | { type: 'LOADED'; forecast: Forecast; aqi: AirQuality | null }
  | { type: 'FAILED' }
  | { type: 'REVALIDATE' }
  | { type: 'RETRY' }

/** Fetch forecast + air quality for a place. AQI is best-effort (a failed
 *  air-quality call still yields a usable forecast). Effects must catch their
 *  own errors and return a completion event — never throw at the host. */
async function load(place: Place): Promise<Events> {
  try {
    const [forecast, aqi] = await Promise.all([
      fetchForecast(place.lat, place.lon),
      fetchAirQuality(place.lat, place.lon).catch(() => null),
    ])
    return { type: 'LOADED', forecast, aqi }
  } catch {
    return { type: 'FAILED' }
  }
}

const applyLoaded = (ctx: Ctx, ev: { forecast: Forecast; aqi: AirQuality | null }): void => {
  ctx.forecast = ev.forecast
  ctx.aqi = ev.aqi
  ctx.status = 'ready'
  ctx.updatedAt = Date.now()
}

const applyLocation = (ctx: Ctx, ev: { place: Place }): void => {
  ctx.place = ev.place
  ctx.status = 'loading'
}

export default defineMachine({
  name: 'WeatherMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: {
    place: DEFAULT_PLACE,
    forecast: null,
    aqi: null,
    status: 'loading',
    updatedAt: null,
  } as Ctx,
  initial: 'loading',
  states: {
    loading: {
      entry: async (ctx): Promise<Events | null> => load(ctx.place),
      on: {
        LOADED: { to: 'ready', do: applyLoaded },
        FAILED: {
          to: 'error',
          do: (ctx) => {
            ctx.status = 'error'
          },
        },
      },
    },
    ready: {
      // Wall-clock revalidation — fires with no request in flight, streams the
      // refreshed conditions to any open page.
      after: [{ delay: REVALIDATE_MS, send: { type: 'REVALIDATE' } }],
      on: {
        REVALIDATE: { to: 'revalidating' },
        SET_LOCATION: { to: 'loading', do: applyLocation },
      },
    },
    revalidating: {
      // status stays 'ready' here, so the page keeps showing data during refresh.
      entry: async (ctx): Promise<Events | null> => load(ctx.place),
      on: {
        LOADED: { to: 'ready', do: applyLoaded },
        FAILED: { to: 'ready' }, // keep serving stale on a failed refresh
        SET_LOCATION: { to: 'loading', do: applyLocation },
      },
    },
    error: {
      after: [{ delay: RETRY_MS, send: { type: 'RETRY' } }],
      on: {
        RETRY: { to: 'loading' },
        SET_LOCATION: { to: 'loading', do: applyLocation },
      },
    },
  },
  selectors: {
    status: (ctx) => ctx.status,
    place: (ctx) => ctx.place,
    current: (ctx) => ctx.forecast?.current ?? null,
    hourly: (ctx) => ctx.forecast?.hourly ?? [],
    daily: (ctx) => ctx.forecast?.daily ?? [],
    aqi: (ctx) => ctx.aqi,
    updatedAt: (ctx) => ctx.updatedAt,
  },
})
