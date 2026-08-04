import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import type { Place } from '../lib/open-meteo.ts'
import SearchMachine from '../machines/search.ts'

// SEARCH fires a geocode effect; a bare actor would run it on a microtask, so we
// intercept with a no-op onEffect and deliver RESULTS by hand.
const start = () => createActor(SearchMachine, { onEffect: () => {} }).start()
const sel = SearchMachine.selectors
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

const london: Place = {
  name: 'London', admin: 'England', country: 'United Kingdom', lat: 51.5, lon: -0.1, timezone: 'Europe/London',
}

describe('search', () => {
  it('SEARCH records the query and marks searching', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'lon' })
    expect(sel.query(ctx(s))).toBe('lon')
    expect(sel.searching(ctx(s))).toBe(true)
  })

  it('RESULTS for the current query populate and clear searching', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'lon' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] })
    expect(sel.hasResults(ctx(s))).toBe(true)
    expect(sel.searching(ctx(s))).toBe(false)
  })

  it('a stale RESULTS (the query moved on) is ignored', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'tok' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] }) // for an old query
    expect(sel.hasResults(ctx(s))).toBe(false)
  })

  it('empty distinguishes typed-no-match from not-typed', () => {
    const s = start()
    expect(sel.empty(ctx(s))).toBe(false) // nothing typed yet
    s.send({ type: 'SEARCH', query: 'zzz' })
    s.send({ type: 'RESULTS', query: 'zzz', results: [] })
    expect(sel.empty(ctx(s))).toBe(true)
  })

  it('CLEAR resets query and results', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'lon' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] })
    s.send({ type: 'CLEAR' })
    expect(sel.query(ctx(s))).toBe('')
    expect(sel.hasResults(ctx(s))).toBe(false)
  })
})
