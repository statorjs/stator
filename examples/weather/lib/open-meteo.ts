/**
 * Open-Meteo data layer — keyless, global. Every fetch here runs SERVER-SIDE
 * (from a machine's entry effect or a `defer` thunk), so there is no CORS to
 * fight and no API key to leak. Endpoints:
 *   - forecast:      https://api.open-meteo.com/v1/forecast
 *   - air quality:   https://air-quality-api.open-meteo.com/v1/air-quality
 *   - geocoding:     https://geocoding-api.open-meteo.com/v1/search
 *
 * Weather conditions come back as WMO codes; `conditionKind` maps them to the
 * scene/icon families the UI draws.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

// ---- WMO weather codes --------------------------------------------------
export type ConditionKind =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'showers'
  | 'snow'
  | 'thunder'

const LABELS: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
}

export function conditionLabel(code: number): string {
  return LABELS[code] ?? 'Unknown'
}

export function conditionKind(code: number): ConditionKind {
  if (code <= 1) return 'clear'
  if (code === 2) return 'partly'
  if (code === 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 86) return code >= 85 ? 'snow' : 'showers'
  if (code >= 95) return 'thunder'
  return 'cloudy'
}

/** The animated-sky scene id (with day/night variants) the live-sky island draws. */
export type SceneKind =
  | 'clear-day'
  | 'clear-night'
  | 'partly-day'
  | 'partly-night'
  | 'cloudy'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'thunder'

export function sceneKind(code: number, isDay: boolean): SceneKind {
  switch (conditionKind(code)) {
    case 'clear':
      return isDay ? 'clear-day' : 'clear-night'
    case 'partly':
      return isDay ? 'partly-day' : 'partly-night'
    case 'fog':
      return 'fog'
    case 'drizzle':
    case 'rain':
    case 'showers':
      return 'rain'
    case 'snow':
      return 'snow'
    case 'thunder':
      return 'thunder'
    default:
      return 'cloudy'
  }
}

// ---- Domain types -------------------------------------------------------
export interface Place {
  name: string
  admin?: string
  country: string
  countryCode?: string
  lat: number
  lon: number
  timezone: string
}

export interface Current {
  time: string
  code: number
  isDay: boolean
  temp: number
  feels: number
  humidity: number
  precip: number
  wind: number
  gust: number
  dir: number
  pressure: number
  uv: number
}

export interface HourPoint {
  time: string // "HH:MM" local
  code: number
  temp: number
  humidity: number
  precipProb: number
  precip: number
  wind: number
  dir: number
}

export interface DayPoint {
  date: string // "YYYY-MM-DD"
  code: number
  tmax: number
  tmin: number
  precipProb: number
  precipSum: number
  windMax: number
  gustMax: number
  dir: number
  sunrise: string // "YYYY-MM-DDTHH:MM"
  sunset: string
  uvMax: number
}

export interface Forecast {
  timezone: string
  current: Current
  hourly: HourPoint[] // next 24 hours
  daily: DayPoint[] // up to 10 days
}

export interface AirQuality {
  aqi: number
  category: string
  pollutant: string
}

// ---- Geocoding ----------------------------------------------------------
interface GeoResult {
  name: string
  admin1?: string
  country?: string
  country_code?: string
  latitude: number
  longitude: number
  timezone?: string
}

export async function geocode(query: string): Promise<Place[]> {
  const q = query.trim()
  if (!q) return []
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`geocode failed: ${res.status}`)
  const data = (await res.json()) as { results?: GeoResult[] }
  return (data.results ?? []).map((r) => ({
    name: r.name,
    admin: r.admin1,
    country: r.country ?? '',
    countryCode: r.country_code,
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone ?? 'auto',
  }))
}

// ---- Forecast -----------------------------------------------------------
const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'pressure_msl',
].join(',')

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
].join(',')

const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'sunrise',
  'sunset',
  'uv_index_max',
].join(',')

interface ForecastResponse {
  timezone: string
  current: {
    time: string
    temperature_2m: number
    relative_humidity_2m: number
    apparent_temperature: number
    is_day: number
    precipitation: number
    weather_code: number
    wind_speed_10m: number
    wind_direction_10m: number
    wind_gusts_10m: number
    pressure_msl: number
  }
  hourly: {
    time: string[]
    temperature_2m: number[]
    relative_humidity_2m: number[]
    precipitation_probability: Array<number | null>
    precipitation: number[]
    weather_code: number[]
    wind_speed_10m: number[]
    wind_direction_10m: number[]
  }
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    precipitation_sum: number[]
    precipitation_probability_max: Array<number | null>
    wind_speed_10m_max: number[]
    wind_gusts_10m_max: number[]
    wind_direction_10m_dominant: number[]
    sunrise: string[]
    sunset: string[]
    uv_index_max: number[]
  }
}

export async function fetchForecast(lat: number, lon: number): Promise<Forecast> {
  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&current=${CURRENT_VARS}&hourly=${HOURLY_VARS}&daily=${DAILY_VARS}` +
    `&timezone=auto&forecast_days=10`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`forecast failed: ${res.status}`)
  const d = (await res.json()) as ForecastResponse

  const c = d.current
  const current: Current = {
    time: c.time,
    code: c.weather_code,
    isDay: c.is_day === 1,
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precip: c.precipitation,
    wind: c.wind_speed_10m,
    gust: c.wind_gusts_10m,
    dir: c.wind_direction_10m,
    pressure: Math.round(c.pressure_msl),
    uv: Math.round(d.daily.uv_index_max[0] ?? 0),
  }

  // Slice the next 24 hours starting from the current hour.
  const H = d.hourly
  const cur13 = c.time.slice(0, 13) // "YYYY-MM-DDTHH"
  let start = H.time.findIndex((t) => t.slice(0, 13) === cur13)
  if (start < 0) start = 0
  const hourly: HourPoint[] = []
  for (let i = start; i < start + 24 && i < H.time.length; i++) {
    hourly.push({
      time: H.time[i]!.slice(11, 16),
      code: H.weather_code[i]!,
      temp: H.temperature_2m[i]!,
      humidity: H.relative_humidity_2m[i]!,
      precipProb: H.precipitation_probability[i] ?? 0,
      precip: H.precipitation[i] ?? 0,
      wind: H.wind_speed_10m[i]!,
      dir: H.wind_direction_10m[i]!,
    })
  }

  const D = d.daily
  const daily: DayPoint[] = D.time.map((date, i) => ({
    date,
    code: D.weather_code[i]!,
    tmax: D.temperature_2m_max[i]!,
    tmin: D.temperature_2m_min[i]!,
    precipProb: D.precipitation_probability_max[i] ?? 0,
    precipSum: D.precipitation_sum[i] ?? 0,
    windMax: D.wind_speed_10m_max[i]!,
    gustMax: D.wind_gusts_10m_max[i]!,
    dir: D.wind_direction_10m_dominant[i]!,
    sunrise: D.sunrise[i]!,
    sunset: D.sunset[i]!,
    uvMax: D.uv_index_max[i] ?? 0,
  }))

  return { timezone: d.timezone, current, hourly, daily }
}

// ---- Air quality (European AQI) ----------------------------------------
const AQI_VARS = ['european_aqi', 'pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide'].join(',')

interface AqiResponse {
  current?: {
    european_aqi?: number
    pm2_5?: number
    pm10?: number
    ozone?: number
    nitrogen_dioxide?: number
  }
}

export async function fetchAirQuality(lat: number, lon: number): Promise<AirQuality> {
  const url = `${AIR_URL}?latitude=${lat}&longitude=${lon}&current=${AQI_VARS}&timezone=auto`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`air-quality failed: ${res.status}`)
  const d = (await res.json()) as AqiResponse
  const c = d.current ?? {}
  const aqi = Math.round(c.european_aqi ?? 0)
  return { aqi, category: aqiCategory(aqi), pollutant: dominantPollutant(c) }
}

/** The pollutant nearest its own "poor" threshold — a rough proxy for what's
 *  driving the index. */
function dominantPollutant(c: {
  pm2_5?: number
  pm10?: number
  ozone?: number
  nitrogen_dioxide?: number
}): string {
  const candidates: Array<[string, number | undefined, number]> = [
    ['PM2.5', c.pm2_5, 20],
    ['PM10', c.pm10, 40],
    ['Ozone', c.ozone, 100],
    ['NO₂', c.nitrogen_dioxide, 90],
  ]
  let best = 'PM2.5'
  let bestRatio = -1
  for (const [name, value, limit] of candidates) {
    if (typeof value === 'number') {
      const ratio = value / limit
      if (ratio > bestRatio) {
        bestRatio = ratio
        best = name
      }
    }
  }
  return best
}

// ---- Ratings / formatting helpers --------------------------------------
export function aqiCategory(aqi: number): string {
  if (aqi <= 20) return 'Good'
  if (aqi <= 40) return 'Fair'
  if (aqi <= 60) return 'Moderate'
  if (aqi <= 80) return 'Poor'
  if (aqi <= 100) return 'Very poor'
  return 'Extreme'
}

export function uvRating(uv: number): string {
  if (uv <= 2) return 'Low'
  if (uv <= 5) return 'Moderate'
  if (uv <= 7) return 'High'
  if (uv <= 10) return 'Very high'
  return 'Extreme'
}

export function uvAdvice(uv: number): string {
  if (uv <= 2) return 'No protection needed'
  if (uv <= 5) return 'Sunglasses on bright days'
  if (uv <= 7) return 'Cover up · SPF 30+'
  if (uv <= 10) return 'Avoid the midday sun'
  return 'Stay in shade · SPF 50+'
}

/** AQI tile styling + guidance, keyed to the European AQI bands. `color` drives
 *  the tile background (`--c`); `textColor` keeps the label legible on it. */
export interface AqiInfo {
  label: string
  color: string
  textColor: string
  advice: string
}
export function aqiInfo(aqi: number): AqiInfo {
  if (aqi <= 20) return { label: 'Good', color: '#60A917', textColor: '#fff', advice: 'Air quality is ideal' }
  if (aqi <= 40) return { label: 'Fair', color: '#A4C400', textColor: '#14210a', advice: 'Acceptable for everyone' }
  if (aqi <= 60) return { label: 'Moderate', color: '#E3C800', textColor: '#211d00', advice: 'Sensitive groups take care' }
  if (aqi <= 80) return { label: 'Poor', color: '#FA6800', textColor: '#fff', advice: 'Limit prolonged exertion' }
  if (aqi <= 100) return { label: 'Very poor', color: '#E51400', textColor: '#fff', advice: 'Reduce outdoor activity' }
  return { label: 'Extreme', color: '#A20025', textColor: '#fff', advice: 'Avoid outdoor exertion' }
}

// ---- Moon phase (location-independent, date-driven) ---------------------
export interface MoonPhase {
  illum: number // 0..1 illuminated fraction
  waxing: boolean
  name: string
}

const SYNODIC_MONTH = 29.530588853
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) // 2000-01-06 18:14 UTC

export function moonPhase(nowMs: number): MoonPhase {
  const days = (nowMs - KNOWN_NEW_MOON) / 86_400_000
  const frac = ((days / SYNODIC_MONTH) % 1 + 1) % 1 // 0..1 through the cycle
  const illum = (1 - Math.cos(2 * Math.PI * frac)) / 2
  const waxing = frac < 0.5
  let name = 'New moon'
  if (frac < 0.03 || frac > 0.97) name = 'New moon'
  else if (frac < 0.22) name = 'Waxing crescent'
  else if (frac < 0.28) name = 'First quarter'
  else if (frac < 0.47) name = 'Waxing gibbous'
  else if (frac < 0.53) name = 'Full moon'
  else if (frac < 0.72) name = 'Waning gibbous'
  else if (frac < 0.78) name = 'Last quarter'
  else name = 'Waning crescent'
  return { illum, waxing, name }
}

/** SVG `d` for the lit portion of a moon disc (viewBox centred on 0,0, r=26) —
 *  the terminator is a half-ellipse whose width tracks illumination. */
export function moonPath(illum: number, waxing: boolean): string {
  const r = 26
  const b = r * (1 - 2 * illum)
  const limb = waxing ? 1 : 0
  const term = b >= 0 ? limb : 1 - limb
  return `M 0 ${-r} A ${r} ${r} 0 0 ${limb} 0 ${r} A ${Math.abs(b).toFixed(1)} ${r} 0 0 ${term} 0 ${-r} Z`
}

// ---- Sun arc geometry ---------------------------------------------------
export interface SunArc {
  polar: boolean
  /** Progress path `d` (sunrise → current sun position) for the mini arc. */
  progressPath: string
  sx: number
  sy: number
}

const arcMinutes = (iso: string): number | null => {
  // iso like "2026-07-17T05:12" — take HH:MM.
  const m = iso.match(/T(\d{2}):(\d{2})/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** Place the sun along a fixed arc (viewBox 0 0 128 52) by how far `now` is
 *  between sunrise and sunset. `polar` when the times are missing/degenerate. */
export function sunArc(sunriseISO: string, sunsetISO: string, nowISO: string): SunArc {
  const R = 54
  const cx = 64
  const base = 44
  const rise = arcMinutes(sunriseISO)
  const set = arcMinutes(sunsetISO)
  const now = arcMinutes(nowISO)
  if (rise == null || set == null || now == null || set <= rise) {
    return { polar: true, progressPath: '', sx: cx, sy: base }
  }
  const frac = Math.max(0, Math.min(1, (now - rise) / (set - rise)))
  const ang = Math.PI * (1 - frac)
  const sx = cx - R * Math.cos(ang)
  const sy = base - R * Math.sin(ang)
  const progressPath = `M ${cx - R} ${base} A ${R} ${R} 0 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)}`
  return { polar: false, progressPath, sx: Number(sx.toFixed(1)), sy: Number(sy.toFixed(1)) }
}

/** "HH:MM" from an Open-Meteo local ISO timestamp. */
export function hhmm(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/)
  return m ? m[1]! : '—'
}

// ---- Weather glyphs -----------------------------------------------------
const CLOUD = 'M8 18.5a4.2 4.2 0 0 1-.3-8.4 5.8 5.8 0 0 1 11 1.1A3.6 3.6 0 0 1 18 18.5Z'
type IconKind =
  | 'sun'
  | 'moon'
  | 'pcloud-day'
  | 'pcloud-night'
  | 'cloud'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'thunder'

function iconKind(code: number, isDay: boolean): IconKind {
  if (code <= 1) return isDay ? 'sun' : 'moon'
  if (code === 2) return isDay ? 'pcloud-day' : 'pcloud-night'
  if (code === 3) return 'cloud'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain'
  if (code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'thunder'
  return 'cloud'
}

const SUN = `<circle cx="12" cy="12" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315]
  .map((a) => {
    const r = (a * Math.PI) / 180
    return `<line x1="${(12 + Math.cos(r) * 6.6).toFixed(1)}" y1="${(12 + Math.sin(r) * 6.6).toFixed(1)}" x2="${(12 + Math.cos(r) * 8.6).toFixed(1)}" y2="${(12 + Math.sin(r) * 8.6).toFixed(1)}"/>`
  })
  .join('')}</g>`
const MOON = '<path d="M15.5 3.6A8.4 8.4 0 1 0 20.4 15 6.7 6.7 0 0 1 15.5 3.6Z" fill="currentColor"/>'
const CLOUD_LINE = `<path d="${CLOUD}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`
const CLOUD_FILL = `<path d="${CLOUD}" fill="currentColor" opacity="0.92"/>`
const drops = (n: number): string =>
  `<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${Array.from(
    { length: n },
    (_, i) => `<line x1="${8.5 + i * 3.3}" y1="18.5" x2="${8.5 + i * 3.3 - 1.2}" y2="22"/>`,
  ).join('')}</g>`

/** A simple single-colour weather glyph (inherits the tile's text colour).
 *  Returned as an `<svg>` string for `raw()` injection into forecast rows. */
export function weatherIconSvg(code: number, isDay: boolean): string {
  let inner: string
  switch (iconKind(code, isDay)) {
    case 'sun':
      inner = SUN
      break
    case 'moon':
      inner = MOON
      break
    case 'pcloud-day':
      inner = `<g transform="translate(-3,-3) scale(0.66)">${SUN}</g>${CLOUD_FILL}`
      break
    case 'pcloud-night':
      inner = `<g transform="translate(2,-1) scale(0.62)">${MOON}</g>${CLOUD_FILL}`
      break
    case 'fog':
      inner = `${CLOUD_LINE}<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="6" y1="20" x2="15" y2="20"/><line x1="9" y1="22.5" x2="18" y2="22.5"/></g>`
      break
    case 'drizzle':
    case 'rain':
      inner = CLOUD_LINE + drops(3)
      break
    case 'snow':
      inner = `${CLOUD_LINE}<g fill="currentColor">${[8.5, 12, 15.5].map((x) => `<circle cx="${x}" cy="20.5" r="1.1"/>`).join('')}</g>`
      break
    case 'thunder':
      inner = `${CLOUD_LINE}<path d="M13 18l-2.6 3.2h2.2l-1 2.8 3.4-3.8h-2.2Z" fill="currentColor"/>`
      break
    default:
      inner = CLOUD_LINE
  }
  return `<svg class="wx-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">${inner}</svg>`
}

const CARDINALS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
]

export function cardinal(deg: number): string {
  return CARDINALS[Math.round(deg / 22.5) % 16]!
}

/** A stable key for a place, from its coordinates — used to key saved locations
 *  and their fetched data. */
export function placeId(p: { lat: number; lon: number }): string {
  return `${p.lat.toFixed(3)}_${p.lon.toFixed(3)}`
}
