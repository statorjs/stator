import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import SettingsMachine, { DEFAULT_CLOCK, DEFAULT_UNITS } from '../machines/settings.ts'

// These assert against the exported defaults + the toggle invariants, not the
// literal 'metric'/'24h' — so they keep passing when you change the app's
// starting preferences in settings.ts.
const start = () => createActor(SettingsMachine).start()
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

describe('settings', () => {
  it('starts at the configured defaults', () => {
    const s = start()
    expect(ctx(s).units).toBe(DEFAULT_UNITS)
    expect(ctx(s).clock).toBe(DEFAULT_CLOCK)
  })

  it('TOGGLE_UNITS inverts, and a second toggle round-trips', () => {
    const s = start()
    const first = ctx(s).units
    s.send({ type: 'TOGGLE_UNITS' })
    expect(ctx(s).units).not.toBe(first)
    s.send({ type: 'TOGGLE_UNITS' })
    expect(ctx(s).units).toBe(first)
  })

  it('SET_UNITS changes to a valid value and rejects an invalid one', () => {
    const s = start()
    const other = DEFAULT_UNITS === 'metric' ? 'imperial' : 'metric'
    s.send({ type: 'SET_UNITS', units: other })
    expect(ctx(s).units).toBe(other)
    s.send({ type: 'SET_UNITS', units: 'nonsense' as never })
    expect(ctx(s).units).toBe(other) // rejected, unchanged
  })

  it('TOGGLE_CLOCK inverts, and a second toggle round-trips', () => {
    const s = start()
    const first = ctx(s).clock
    s.send({ type: 'TOGGLE_CLOCK' })
    expect(ctx(s).clock).not.toBe(first)
    s.send({ type: 'TOGGLE_CLOCK' })
    expect(ctx(s).clock).toBe(first)
  })
})
