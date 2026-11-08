import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import SettingsMachine, { DEFAULT_CLOCK, DEFAULT_UNITS } from '../machines/settings.ts'

// These assert against the exported defaults + the toggle invariants, not the
// literal 'metric'/'24h' — so they keep passing when you change the app's
// starting preferences in settings.ts.
const start = () => createActor(SettingsMachine).start()
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

describe('settings', () => {
  it('starts at the configured defaults', () => {
    const s = start()
    assert.equal(ctx(s).units, DEFAULT_UNITS)
    assert.equal(ctx(s).clock, DEFAULT_CLOCK)
  })

  it('TOGGLE_UNITS inverts, and a second toggle round-trips', () => {
    const s = start()
    const first = ctx(s).units
    s.send({ type: 'TOGGLE_UNITS' })
    assert.notEqual(ctx(s).units, first)
    s.send({ type: 'TOGGLE_UNITS' })
    assert.equal(ctx(s).units, first)
  })

  it('SET_UNITS changes to a valid value and rejects an invalid one', () => {
    const s = start()
    const other = DEFAULT_UNITS === 'metric' ? 'imperial' : 'metric'
    s.send({ type: 'SET_UNITS', units: other })
    assert.equal(ctx(s).units, other)
    s.send({ type: 'SET_UNITS', units: 'nonsense' as never })
    assert.equal(ctx(s).units, other) // rejected, unchanged
  })

  it('TOGGLE_CLOCK inverts, and a second toggle round-trips', () => {
    const s = start()
    const first = ctx(s).clock
    s.send({ type: 'TOGGLE_CLOCK' })
    assert.notEqual(ctx(s).clock, first)
    s.send({ type: 'TOGGLE_CLOCK' })
    assert.equal(ctx(s).clock, first)
  })
})
