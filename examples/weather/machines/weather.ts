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
  weatherIconSvg,
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

/** Everything one city panel renders, computed for a single place id. The whole
 *  panel (hero + every tile) is per-location, so the Panorama slides between
 *  complete pages — the template binds `panelForId(p.id).<field>` throughout. */
interface PanelVM {
  status: 'loading' | 'ready' | 'error'
  scene: string
  temp: string
  cond: string
  feels: string
  wind: string
  gust: string
  windUnit: string
  cardinal: string
  dir: number
  windTransform: string
  humidity: number | string
  uv: number | string
  uvRating: string
  uvAdvice: string
  aqi: number | string
  aqiLabel: string
  aqiColor: string
  aqiTextColor: string
  aqiAdvice: string
  aqiPollutant: string
  precip: string
  precipUnit: string
  pressure: number | string
  sunrise: string
  sunset: string
  sunPath: string
  sunX: number
  sunY: number
  moonName: string
  moonIllumPct: number
  moonPath: string
}

const panelVM = (ctx: Ctx, id: string): PanelVM => {
  const d = ctx.data[id]
  const c = d?.forecast?.current ?? null
  const day0 = d?.forecast?.daily?.[0] ?? null
  const aq = d?.aqi ?? null
  const aqInfo = aq ? aqiInfo(aq.aqi) : null
  const sun = day0 && c ? sunArc(day0.sunrise, day0.sunset, c.time) : null
  const moon = moonPhase(Date.now())
  return {
    status: d?.status ?? 'loading',
    scene: c ? sceneKind(c.code, c.isDay) : 'cloudy',
    temp: fmtTemp(c?.temp, ctx.units),
    cond: c ? conditionLabel(c.code) : '',
    feels: fmtTemp(c?.feels, ctx.units),
    wind: fmtWind(c?.wind, ctx.units),
    gust: fmtWind(c?.gust, ctx.units),
    windUnit: windUnit(ctx.units),
    cardinal: c ? cardinal(c.dir) : '—',
    dir: c?.dir ?? 0,
    windTransform: `rotate(${c ? (c.dir + 180) % 360 : 0} 12 12)`,
    humidity: c?.humidity ?? '—',
    uv: c?.uv ?? '—',
    uvRating: c ? uvRating(c.uv) : '—',
    uvAdvice: c ? uvAdvice(c.uv) : '',
    aqi: aq?.aqi ?? '—',
    aqiLabel: aqInfo?.label ?? '—',
    aqiColor: aqInfo?.color ?? '#647687',
    aqiTextColor: aqInfo?.textColor ?? '#fff',
    aqiAdvice: aqInfo?.advice ?? '',
    aqiPollutant: aq?.pollutant ?? '',
    precip: fmtPrecip(c?.precip, ctx.units),
    precipUnit: precipUnit(ctx.units),
    pressure: c?.pressure ?? '—',
    sunrise: day0 ? fmtClock(hhmm(day0.sunrise), ctx.clock) : '—',
    sunset: day0 ? fmtClock(hhmm(day0.sunset), ctx.clock) : '—',
    sunPath: sun && !sun.polar ? sun.progressPath : '',
    sunX: sun ? sun.sx : 64,
    sunY: sun ? sun.sy : 44,
    moonName: moon.name,
    moonIllumPct: Math.round(moon.illum * 100),
    moonPath: moonPath(moon.illum, moon.waxing),
  }
}

// ---- Forecast rows (separate from the scalar VM so a scalar read doesn't
//      rebuild these arrays) ------------------------------------------------
export interface HourRow {
  time: string
  temp: string
  precip: string
  icon: string
}
export interface DayRow {
  day: string
  date: string
  hi: string
  lo: string
  precip: string
  icon: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (dateStr: string, i: number): string => {
  if (i === 0) return 'Today'
  const wd = new Date(`${dateStr}T12:00:00`).getDay()
  return WEEKDAYS[wd] ?? dateStr
}
/** Only surface a meaningful chance of precipitation; dry hours/days stay blank. */
const pop = (prob: number): string => (prob >= 15 ? `${prob}%` : '')
/** Rough day/night for an hour label, for the glyph (no per-hour is_day field). */
const hourIsDay = (time: string): boolean => time >= '07:00' && time <= '19:00'

const hourlyVM = (ctx: Ctx, id: string): HourRow[] =>
  (ctx.data[id]?.forecast?.hourly ?? []).slice(0, 12).map((h, i) => ({
    time: i === 0 ? 'Now' : fmtClock(h.time, ctx.clock),
    temp: fmtTemp(h.temp, ctx.units),
    precip: pop(h.precipProb),
    icon: weatherIconSvg(h.code, hourIsDay(h.time)),
  }))

const dailyVM = (ctx: Ctx, id: string): DayRow[] =>
  (ctx.data[id]?.forecast?.daily ?? []).map((d, i) => ({
    day: weekdayOf(d.date, i),
    date: d.date.slice(8, 10),
    hi: fmtTemp(d.tmax, ctx.units),
    lo: fmtTemp(d.tmin, ctx.units),
    precip: pop(d.precipProb),
    icon: weatherIconSvg(d.code, true),
  }))

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
    /** Everything a single city panel renders. The Panorama binds
     *  `panelForId(p.id).<field>` per tile inside a keyed `each`, so each panel
     *  is fully per-location and slides as one page. Element ids inside the arm
     *  are key-scoped and nested reads resolve the current runtime, so every
     *  panel's island + bindings stay independently live. */
    panelForId: (ctx) => (id: string): PanelVM => panelVM(ctx, id),
    /** Forecast rows, kept off the scalar VM so a scalar tile read doesn't
     *  rebuild them. Bound with a NON-keyed `each` so a units toggle reformats
     *  the whole strip (the rows are static text — no islands to churn). */
    hourlyForId: (ctx) => (id: string): HourRow[] => hourlyVM(ctx, id),
    dailyForId: (ctx) => (id: string): DayRow[] => dailyVM(ctx, id),
  },
})
