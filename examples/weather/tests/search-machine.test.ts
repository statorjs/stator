import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
    assert.equal(sel.query(ctx(s)), 'lon')
    assert.equal(sel.searching(ctx(s)), true)
  })

  it('RESULTS for the current query populate and clear searching', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'lon' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] })
    assert.equal(sel.hasResults(ctx(s)), true)
    assert.equal(sel.searching(ctx(s)), false)
  })

  it('a stale RESULTS (the query moved on) is ignored', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'tok' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] }) // for an old query
    assert.equal(sel.hasResults(ctx(s)), false)
  })

  it('empty distinguishes typed-no-match from not-typed', () => {
    const s = start()
    assert.equal(sel.empty(ctx(s)), false) // nothing typed yet
    s.send({ type: 'SEARCH', query: 'zzz' })
    s.send({ type: 'RESULTS', query: 'zzz', results: [] })
    assert.equal(sel.empty(ctx(s)), true)
  })

  it('PICK emits the chosen result and clears the search', () => {
    const s = start()
    const picked: unknown[] = []
    s.on('PICKED', (e) => picked.push(e))
    s.send({ type: 'SEARCH', query: 'lon' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] })
    s.send({ type: 'PICK', index: 0 })
    assert.deepEqual(picked, [{ type: 'PICKED', place: london }])
    assert.equal(sel.query(ctx(s)), '')
    assert.equal(sel.hasResults(ctx(s)), false)
  })

  it('PICK of a row that is not there does nothing', () => {
    const s = start()
    s.send({ type: 'SEARCH', query: 'lon' })
    s.send({ type: 'RESULTS', query: 'lon', results: [london] })
    for (const index of [1, -1, 0.5, '0' as never]) s.send({ type: 'PICK', index })
    assert.equal(sel.hasResults(ctx(s)), true)
  })
})
