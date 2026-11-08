import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaceData } from '../machines/forecast-cache.ts'
import PanelsMachine from '../machines/panels.ts'

// PanelsMachine holds no state — its selectors are pure joins over two read
// machines. Call them directly with a stub `reads` (the resolved selector values
// the server would inject at dispatch time).

const placeData: PlaceData = {
  status: 'ready',
  updatedAt: 1_000,
  forecast: {
    timezone: 'Europe/London',
    current: { time: '2026-07-17T12:00', code: 0, isDay: true, temp: 20, feels: 19, humidity: 55, precip: 0, wind: 18, gust: 30, dir: 90, pressure: 1013, uv: 6 },
    hourly: [
      { time: '12:00', code: 0, temp: 20, humidity: 55, precipProb: 0, precip: 0, wind: 18, dir: 90 },
      { time: '13:00', code: 61, temp: 19, humidity: 60, precipProb: 40, precip: 0.5, wind: 20, dir: 95 },
    ],
    daily: [
      { date: '2026-07-17', code: 0, tmax: 24, tmin: 14, precipProb: 20, precipSum: 1.2, windMax: 25, gustMax: 35, dir: 90, sunrise: '2026-07-17T05:00', sunset: '2026-07-17T21:00', uvMax: 6 },
    ],
  },
  aqi: { aqi: 15, category: 'Good', pollutant: 'PM2.5' },
}

type Units = 'metric' | 'imperial'
type Clock = '12h' | '24h'

const readsFor = (units: Units = 'metric', clock: Clock = '24h', data: PlaceData | null = placeData) =>
  ({
    reads: {
      WeatherMachine: { units, clock, places: [{ id: 'p1' }], activeId: 'p1' },
      ForecastCache: { byId: (id: string) => (id === 'p1' ? data : null), fetchingIds: [] as string[] },
    },
  }) as never

const panel = (opts: { units?: Units; clock?: Clock; data?: PlaceData | null } = {}) =>
  PanelsMachine.selectors.panelForId(
    {},
    readsFor(opts.units, opts.clock, 'data' in opts ? opts.data : placeData),
  )('p1')

describe('panels — panel view-model', () => {
  it('formats metric by default', () => {
    const vm = panel()
    assert.equal(vm.status, 'ready')
    assert.equal(vm.temp, '20°')
    assert.equal(vm.cond, 'Clear')
    assert.equal(vm.scene, 'clear-day')
    assert.equal(vm.wind, '18')
    assert.equal(vm.windUnit, 'km/h')
    assert.equal(vm.cardinal, 'E') // 90°
  })

  it('converts to imperial when units=imperial', () => {
    const vm = panel({ units: 'imperial' })
    assert.equal(vm.temp, '68°') // 20°C -> 68°F
    assert.equal(vm.windUnit, 'mph')
  })

  it('reformats the sun times to a 12h clock', () => {
    const vm = panel({ clock: '12h' })
    assert.equal(vm.sunrise, '5:00 am')
    assert.equal(vm.sunset, '9:00 pm')
  })

  it('yields a loading VM when the place has no data yet', () => {
    const vm = panel({ data: null })
    assert.equal(vm.status, 'loading')
    assert.equal(vm.temp, '—')
  })
})

describe('panels — forecast rows', () => {
  it('hourlyForId labels the first hour Now and shows a meaningful pop', () => {
    const rows = PanelsMachine.selectors.hourlyForId({}, readsFor())('p1')
    assert.equal(rows[0]?.time, 'Now')
    assert.equal(rows[0]?.temp, '20°')
    assert.equal(rows[1]?.precip, '40%')
  })

  it('dailyForId labels the first day Today', () => {
    const rows = PanelsMachine.selectors.dailyForId({}, readsFor())('p1')
    assert.equal(rows[0]?.day, 'Today')
    assert.equal(rows[0]?.hi, '24°')
    assert.equal(rows[0]?.lo, '14°')
  })
})

describe('panels — cross-machine flags', () => {
  it('refreshing is true when the cache is fetching one of my places', () => {
    const reads = {
      reads: {
        WeatherMachine: { units: 'metric', clock: '24h', places: [{ id: 'p1' }], activeId: 'p1' },
        ForecastCache: { byId: () => null, fetchingIds: ['p1'] },
      },
    } as never
    assert.equal(PanelsMachine.selectors.refreshing({}, reads), true)
  })

  it('updatedAtMs reflects the active place load time', () => {
    assert.equal(PanelsMachine.selectors.updatedAtMs({}, readsFor()), 1_000)
  })
})
