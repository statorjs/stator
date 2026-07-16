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
