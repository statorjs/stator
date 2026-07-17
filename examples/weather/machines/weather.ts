import { defineMachine } from '@statorjs/stator/server'
import {
  type AirQuality,
  aqiInfo,
  cardinal,
  conditionLabel,
  type Current,
  type DayPoint,
  fetchAirQuality,
  fetchForecast,
  type Forecast,
  hhmm,
  moonPath,
  moonPhase,
  type Place,
  placeId,
  sceneKind,
  sunArc,
  uvAdvice,
  uvRating,
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

const fmtWind = (kmh: number | null | undefined, units: Units): string => {
  if (kmh == null) return '—'
  return units === 'imperial' ? `${Math.round(kmh * 0.621371)}` : `${Math.round(kmh)}`
}

const fmtPrecip = (mm: number | null | undefined, units: Units): string => {
  if (mm == null) return '—'
  return units === 'imperial' ? (mm * 0.0393701).toFixed(2) : mm.toFixed(1)
}

const windUnit = (units: Units): string => (units === 'imperial' ? 'mph' : 'km/h')
const precipUnit = (units: Units): string => (units === 'imperial' ? 'in' : 'mm')

/** Reformat a 24h "HH:MM" into the chosen clock — exercises the Settings.clock
 *  toggle end-to-end (server-canonical, synced across tabs). */
const fmtClock = (hm: string, clock: Clock): string => {
  if (clock === '24h' || !/^\d{2}:\d{2}$/.test(hm)) return hm
  const [h, m] = hm.split(':').map(Number) as [number, number]
  const ap = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`
}

// Active-place accessors shared by the tile selectors below.
const curOf = (ctx: Ctx): Current | null => ctx.data[ctx.activeId]?.forecast?.current ?? null
const day0Of = (ctx: Ctx): DayPoint | null => ctx.data[ctx.activeId]?.forecast?.daily?.[0] ?? null
const aqiOf = (ctx: Ctx): AirQuality | null => ctx.data[ctx.activeId]?.aqi ?? null

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
    /** Per-place current temperature, formatted in the active units — lets each
     *  Pivot tab show its own reading. Curried so a template can call it per row. */
    tempForId: (ctx) => (id: string): string =>
      fmtTemp(ctx.data[id]?.forecast?.current?.temp, ctx.units),
    /** Per-place hero fields — one live panel per saved location in the carousel.
     *  Element ids inside the keyed `each` are key-scoped, and nested reads
     *  resolve the current runtime, so each panel's island + bindings are live. */
    sceneForId: (ctx) => (id: string): string => {
      const c = ctx.data[id]?.forecast?.current
      return c ? sceneKind(c.code, c.isDay) : 'cloudy'
    },
    statusForId: (ctx) => (id: string): string => ctx.data[id]?.status ?? 'loading',
    condForId: (ctx) => (id: string): string => {
      const c = ctx.data[id]?.forecast?.current
      return c ? conditionLabel(c.code) : ''
    },
    feelsForId: (ctx) => (id: string): string =>
      fmtTemp(ctx.data[id]?.forecast?.current?.feels, ctx.units),
    windForId: (ctx) => (id: string): string =>
      fmtWind(ctx.data[id]?.forecast?.current?.wind, ctx.units),
    cardinalForId: (ctx) => (id: string): string => {
      const c = ctx.data[id]?.forecast?.current
      return c ? cardinal(c.dir) : '—'
    },
    humidityForId: (ctx) => (id: string): number | string =>
      ctx.data[id]?.forecast?.current?.humidity ?? '—',
    activeStatus: (ctx) => ctx.data[ctx.activeId]?.status ?? 'loading',
    activeCurrent: (ctx): Current | null => ctx.data[ctx.activeId]?.forecast?.current ?? null,
    /** Temperature in the chosen unit — a single binding that re-renders on both
     *  a weather refresh and a units toggle (units are mirrored into this ctx). */
    activeTempDisplay: (ctx) => fmtTemp(ctx.data[ctx.activeId]?.forecast?.current?.temp, ctx.units),
    /** Scene id for the live-sky island — updates live on refresh / location switch. */
    activeScene: (ctx) => {
      const c = ctx.data[ctx.activeId]?.forecast?.current
      return c ? sceneKind(c.code, c.isDay) : 'cloudy'
    },
    activeConditionLabel: (ctx) => {
      const c = curOf(ctx)
      return c ? conditionLabel(c.code) : ''
    },

    // --- Current-tile meta line -------------------------------------------
    activeFeelsDisplay: (ctx) => fmtTemp(curOf(ctx)?.feels, ctx.units),
    activeHumidity: (ctx) => curOf(ctx)?.humidity ?? '—',

    // --- UV tile (peek) ---------------------------------------------------
    activeUv: (ctx) => curOf(ctx)?.uv ?? '—',
    activeUvRating: (ctx) => {
      const c = curOf(ctx)
      return c ? uvRating(c.uv) : '—'
    },
    activeUvAdvice: (ctx) => {
      const c = curOf(ctx)
      return c ? uvAdvice(c.uv) : ''
    },

    // --- Air-quality tile (peek, colour-keyed) ----------------------------
    activeAqi: (ctx) => aqiOf(ctx)?.aqi ?? '—',
    activeAqiLabel: (ctx) => {
      const a = aqiOf(ctx)
      return a ? aqiInfo(a.aqi).label : '—'
    },
    activeAqiColor: (ctx) => {
      const a = aqiOf(ctx)
      return a ? aqiInfo(a.aqi).color : '#647687'
    },
    activeAqiTextColor: (ctx) => {
      const a = aqiOf(ctx)
      return a ? aqiInfo(a.aqi).textColor : '#fff'
    },
    activeAqiAdvice: (ctx) => {
      const a = aqiOf(ctx)
      return a ? aqiInfo(a.aqi).advice : ''
    },
    activeAqiPollutant: (ctx) => aqiOf(ctx)?.pollutant ?? '',

    // --- Wind tile (flip, compass) ----------------------------------------
    activeWindDisplay: (ctx) => fmtWind(curOf(ctx)?.wind, ctx.units),
    activeGustDisplay: (ctx) => fmtWind(curOf(ctx)?.gust, ctx.units),
    activeWindUnit: (ctx) => windUnit(ctx.units),
    activeWindCardinal: (ctx) => {
      const c = curOf(ctx)
      return c ? cardinal(c.dir) : '—'
    },
    activeWindDir: (ctx) => curOf(ctx)?.dir ?? 0,
    /** SVG transform for the compass needle (points FROM the wind's origin). */
    activeWindTransform: (ctx) => {
      const c = curOf(ctx)
      return `rotate(${c ? (c.dir + 180) % 360 : 0} 12 12)`
    },

    // --- Humidity / precip tiles (static) ---------------------------------
    activePrecipDisplay: (ctx) => fmtPrecip(curOf(ctx)?.precip, ctx.units),
    activePrecipUnit: (ctx) => precipUnit(ctx.units),
    activePressure: (ctx) => curOf(ctx)?.pressure ?? '—',

    // --- Sun tile (static, arc) -------------------------------------------
    activeSunrise: (ctx) => {
      const d = day0Of(ctx)
      return d ? fmtClock(hhmm(d.sunrise), ctx.clock) : '—'
    },
    activeSunset: (ctx) => {
      const d = day0Of(ctx)
      return d ? fmtClock(hhmm(d.sunset), ctx.clock) : '—'
    },
    activeSunPath: (ctx) => {
      const d = day0Of(ctx)
      const c = curOf(ctx)
      return d && c ? sunArc(d.sunrise, d.sunset, c.time).progressPath : ''
    },
    activeSunX: (ctx) => {
      const d = day0Of(ctx)
      const c = curOf(ctx)
      return d && c ? sunArc(d.sunrise, d.sunset, c.time).sx : 64
    },
    activeSunY: (ctx) => {
      const d = day0Of(ctx)
      const c = curOf(ctx)
      return d && c ? sunArc(d.sunrise, d.sunset, c.time).sy : 44
    },

    // --- Moon tile (static, date-driven) ----------------------------------
    activeMoonName: () => moonPhase(Date.now()).name,
    activeMoonIllumPct: () => Math.round(moonPhase(Date.now()).illum * 100),
    activeMoonPath: () => {
      const m = moonPhase(Date.now())
      return moonPath(m.illum, m.waxing)
    },
  },
})
