import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import type { Forecast } from '../lib/open-meteo.ts'
import ForecastCache from '../machines/forecast-cache.ts'

// REFRESH fires a fetch effect; intercept it so the test delivers LOADED by hand.
const start = () => createActor(ForecastCache, { onEffect: () => {} }).start()
const sel = ForecastCache.selectors
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

const req = (id: string) => ({ id, lat: 0, lon: 0 })
const forecast = { timezone: 'UTC', current: {}, hourly: [], daily: [] } as unknown as Forecast

describe('forecast-cache', () => {
  it('REFRESH for an uncached place marks it fetching', () => {
    const c = start()
    c.send({ type: 'REFRESH', places: [req('p1')] })
    expect(sel.fetchingIds(ctx(c))).toContain('p1')
  })

  it('LOADED stores the data and clears the fetching mark', () => {
    const c = start()
    c.send({ type: 'REFRESH', places: [req('p1')] })
    c.send({ type: 'LOADED', results: [{ id: 'p1', forecast, aqi: null }] })
    expect(sel.byId(ctx(c))('p1')?.status).toBe('ready')
    expect(sel.fetchingIds(ctx(c))).not.toContain('p1')
  })

  it('a failed load records an error entry', () => {
    const c = start()
    c.send({ type: 'REFRESH', places: [req('p1')] })
    c.send({ type: 'LOADED', results: [{ id: 'p1', failed: true }] })
    expect(sel.byId(ctx(c))('p1')?.status).toBe('error')
  })

  it('the policy guard drops a REFRESH for an already-fresh place', () => {
    const c = start()
    c.send({ type: 'REFRESH', places: [req('p1')] })
    c.send({ type: 'LOADED', results: [{ id: 'p1', forecast, aqi: null }] })
    // p1 was just loaded (fresh) — a second REFRESH is dropped before it commits.
    c.send({ type: 'REFRESH', places: [req('p1')] })
    expect(sel.fetchingIds(ctx(c))).not.toContain('p1')
  })
})
