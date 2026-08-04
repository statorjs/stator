import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import type { Place } from '../lib/open-meteo.ts'
import { DEFAULT_CLOCK, DEFAULT_UNITS } from '../machines/settings.ts'
import WeatherMachine, { DEFAULT_PLACES } from '../machines/weather.ts'

// Asserts against DEFAULT_PLACES + the exported preference defaults, not the
// specific seed cities — so they keep passing when you change which locations
// the app ships with.
const start = () => createActor(WeatherMachine).start()
const sel = WeatherMachine.selectors
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

// A synthetic place, deliberately not in the default set, so the "add a new
// location" cases hold whatever cities the app defaults to.
const berlin: Place = {
  name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.405, timezone: 'Europe/Berlin',
}

describe('weather — places', () => {
  it('seeds the configured default places, the first one active', () => {
    const w = start()
    expect(sel.places(ctx(w))).toHaveLength(DEFAULT_PLACES.length)
    expect(sel.active(ctx(w))?.id).toBe(DEFAULT_PLACES[0]!.id)
  })

  it('ADD_PLACE adds a new place and makes it active', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin })
    expect(sel.active(ctx(w))?.name).toBe('Berlin')
    expect(sel.places(ctx(w)).some((p) => p.name === 'Berlin')).toBe(true)
  })

  it('ADD_PLACE of an existing place does not duplicate it', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin })
    w.send({ type: 'ADD_PLACE', place: berlin })
    expect(sel.places(ctx(w)).filter((p) => p.name === 'Berlin')).toHaveLength(1)
  })

  it('SET_ACTIVE only switches to a place that exists', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin }) // Berlin now active
    const first = DEFAULT_PLACES[0]!
    w.send({ type: 'SET_ACTIVE', id: first.id })
    expect(sel.active(ctx(w))?.id).toBe(first.id) // switched
    w.send({ type: 'SET_ACTIVE', id: 'no-such-id' })
    expect(sel.active(ctx(w))?.id).toBe(first.id) // unchanged
  })

  it('REMOVE_PLACE drops a place and reassigns active if it was the removed one', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin }) // active = Berlin; guarantees >= 2 places
    const activeId = sel.active(ctx(w))!.id
    w.send({ type: 'REMOVE_PLACE', id: activeId })
    expect(sel.places(ctx(w)).some((p) => p.id === activeId)).toBe(false)
    expect(sel.active(ctx(w))?.id).not.toBe(activeId) // reassigned
  })

  it('REMOVE_PLACE always keeps at least one place', () => {
    const w = start()
    for (const p of [...sel.places(ctx(w))]) w.send({ type: 'REMOVE_PLACE', id: p.id })
    expect(sel.places(ctx(w)).length).toBeGreaterThanOrEqual(1)
  })

  it('SETTINGS_CHANGED mirrors units + clock for local re-render', () => {
    const w = start()
    const units = DEFAULT_UNITS === 'metric' ? 'imperial' : 'metric'
    const clock = DEFAULT_CLOCK === '24h' ? '12h' : '24h'
    w.send({ type: 'SETTINGS_CHANGED', units, clock })
    expect(sel.units(ctx(w))).toBe(units)
    expect(sel.clock(ctx(w))).toBe(clock)
  })
})
