import { defineMachine } from '@statorjs/stator/server'
import {
  aqiInfo,
  cardinal,
  conditionLabel,
  hhmm,
  moonPath,
  moonPhase,
  sceneKind,
  sunArc,
  uvAdvice,
  uvRating,
  weatherIconSvg,
} from '../lib/open-meteo.ts'
import ForecastCache, { type PlaceData } from './forecast-cache.ts'
import type { Clock, Units } from './settings.ts'
import WeatherMachine, { type SavedPlace } from './weather.ts'

/**
 * The DISPLAY machine: every tile view-model, computed by READING two other
 * machines — the session's WeatherMachine (places, active, mirrored prefs)
 * and the shared ForecastCache (the data). It holds no state of its own; its
 * selectors receive `{ reads }` and join the two sources per place id.
 *
 * The split is what keeps the machine module graph acyclic (weather emits to
 * the cache; the cache never has to know about display), and it's the reason
 * a cache update pushes to every open tab of every interested session: fan-out
 * expands touched machines through the reverse-reads graph, so bindings on
 * this machine re-diff whenever either source moves.
 */

// ---- Formatting (unit/clock aware) --------------------------------------
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

const panelVM = (
  units: Units,
  clock: Clock,
  data: PlaceData | null,
): PanelVM => {
  const c = data?.forecast?.current ?? null
  const day0 = data?.forecast?.daily?.[0] ?? null
  const aq = data?.aqi ?? null
  const aqInfo = aq ? aqiInfo(aq.aqi) : null
  const sun = day0 && c ? sunArc(day0.sunrise, day0.sunset, c.time) : null
  const moon = moonPhase(Date.now())
  return {
    status: data?.status ?? 'loading',
    scene: c ? sceneKind(c.code, c.isDay) : 'cloudy-day',
    temp: fmtTemp(c?.temp, units),
    cond: c ? conditionLabel(c.code) : '',
    feels: fmtTemp(c?.feels, units),
    wind: fmtWind(c?.wind, units),
    gust: fmtWind(c?.gust, units),
    windUnit: windUnit(units),
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
    precip: fmtPrecip(c?.precip, units),
    precipUnit: precipUnit(units),
    pressure: c?.pressure ?? '—',
    sunrise: day0 ? fmtClock(hhmm(day0.sunrise), clock) : '—',
    sunset: day0 ? fmtClock(hhmm(day0.sunset), clock) : '—',
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
  rain: string
  icon: string
}
export interface DayRow {
  day: string
  date: string
  hi: string
  lo: string
  precip: string
  rain: string
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
/** Expected precipitation amount, unit-aware — blank below a meaningful trace. */
const rainAmt = (mm: number | null | undefined, units: Units): string => {
  if (mm == null || mm < 0.1) return ''
  return units === 'imperial' ? `${(mm * 0.0393701).toFixed(2)} in` : `${mm.toFixed(1)} mm`
}
/** Rough day/night for an hour label, for the glyph (no per-hour is_day field). */
const hourIsDay = (time: string): boolean => time >= '07:00' && time <= '19:00'

const hourlyVM = (units: Units, clock: Clock, data: PlaceData | null): HourRow[] =>
  (data?.forecast?.hourly ?? []).slice(0, 24).map((h, i) => ({
    time: i === 0 ? 'Now' : fmtClock(h.time, clock),
    temp: fmtTemp(h.temp, units),
    precip: pop(h.precipProb),
    rain: rainAmt(h.precip, units),
    icon: weatherIconSvg(h.code, hourIsDay(h.time)),
  }))

const dailyVM = (units: Units, data: PlaceData | null): DayRow[] =>
  (data?.forecast?.daily ?? []).map((d, i) => ({
    day: weekdayOf(d.date, i),
    date: d.date.slice(8, 10),
    hi: fmtTemp(d.tmax, units),
    lo: fmtTemp(d.tmin, units),
    // Daily shows a dash for dry days (the aligned column reads cleaner than a
    // blank); the denser hourly strip stays blank via `pop`.
    precip: d.precipProb >= 15 ? `${d.precipProb}%` : '—',
    rain: rainAmt(d.precipSum, units),
    icon: weatherIconSvg(d.code, true),
  }))

export default defineMachine({
  name: 'PanelsMachine',
  lifecycle: 'session',
  // Display-only: no events, no transitions — this machine exists for its
  // reads-joining selectors.
  events: {} as { type: 'NOOP' },
  reads: [WeatherMachine, ForecastCache],
  context: {},
  initial: 'ready',
  states: { ready: {} },
  selectors: {
    /** Everything a single city panel renders — joined per place id from the
     *  session's WeatherMachine and the shared ForecastCache. */
    panelForId: (_ctx, { reads }) => (id: string): PanelVM =>
      panelVM(reads.WeatherMachine.units, reads.WeatherMachine.clock, reads.ForecastCache.byId(id)),
    /** Forecast rows, kept off the scalar VM so a scalar tile read doesn't
     *  rebuild them. Bound with a NON-keyed `each` so a units toggle reformats
     *  the whole strip (the rows are static text — no islands to churn). */
    hourlyForId: (_ctx, { reads }) => (id: string): HourRow[] =>
      hourlyVM(reads.WeatherMachine.units, reads.WeatherMachine.clock, reads.ForecastCache.byId(id)),
    dailyForId: (_ctx, { reads }) => (id: string): DayRow[] =>
      dailyVM(reads.WeatherMachine.units, reads.ForecastCache.byId(id)),
    /** True while the cache is fetching any of THIS session's places — drives
     *  the app bar spinner in every tab (cache changes fan out everywhere). */
    refreshing: (_ctx, { reads }) => {
      const mine = new Set(reads.WeatherMachine.places.map((p: SavedPlace) => p.id))
      return reads.ForecastCache.fetchingIds.some((id: string) => mine.has(id))
    },
    /** Raw epoch of the active place's last load — the app bar's island
     *  formats it VIEWER-local (chrome time; the server can't know the zone). */
    updatedAtMs: (_ctx, { reads }) =>
      reads.ForecastCache.byId(reads.WeatherMachine.activeId)?.updatedAt ?? 0,
  },
})
