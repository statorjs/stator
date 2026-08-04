import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import type { Place } from '../lib/open-meteo.ts'
import WeatherMachine from '../machines/weather.ts'

const start = () => createActor(WeatherMachine).start()
const sel = WeatherMachine.selectors
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

const berlin: Place = {
  name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.405, timezone: 'Europe/Berlin',
}

describe('weather — places', () => {
  it('seeds three default places, London active', () => {
    const w = start()
    expect(sel.places(ctx(w))).toHaveLength(3)
    expect(sel.active(ctx(w))?.name).toBe('London')
  })

  it('ADD_PLACE appends a place and makes it active', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin })
    expect(sel.places(ctx(w))).toHaveLength(4)
    expect(sel.active(ctx(w))?.name).toBe('Berlin')
  })

  it('ADD_PLACE of an existing place does not duplicate it', () => {
    const w = start()
    w.send({ type: 'ADD_PLACE', place: berlin })
    w.send({ type: 'ADD_PLACE', place: berlin })
    expect(sel.places(ctx(w)).filter((p) => p.name === 'Berlin')).toHaveLength(1)
  })

  it('SET_ACTIVE only switches to a place that exists', () => {
    const w = start()
    const tokyo = sel.places(ctx(w)).find((p) => p.name === 'Tokyo')!
    w.send({ type: 'SET_ACTIVE', id: tokyo.id })
    expect(sel.active(ctx(w))?.name).toBe('Tokyo')
    w.send({ type: 'SET_ACTIVE', id: 'no-such-id' })
    expect(sel.active(ctx(w))?.name).toBe('Tokyo') // unchanged
  })

  it('REMOVE_PLACE drops a place and reassigns active if it was the removed one', () => {
    const w = start()
    const londonId = sel.active(ctx(w))!.id
    w.send({ type: 'REMOVE_PLACE', id: londonId })
    expect(sel.places(ctx(w))).toHaveLength(2)
    expect(sel.active(ctx(w))?.id).not.toBe(londonId)
  })

  it('REMOVE_PLACE always keeps at least one place', () => {
    const w = start()
    for (const p of [...sel.places(ctx(w))]) w.send({ type: 'REMOVE_PLACE', id: p.id })
    expect(sel.places(ctx(w)).length).toBeGreaterThanOrEqual(1)
  })

  it('SETTINGS_CHANGED mirrors units + clock for local re-render', () => {
    const w = start()
    w.send({ type: 'SETTINGS_CHANGED', units: 'imperial', clock: '12h' })
    expect(sel.units(ctx(w))).toBe('imperial')
    expect(sel.clock(ctx(w))).toBe('12h')
  })
})
