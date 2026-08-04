import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import SettingsMachine from '../machines/settings.ts'

const start = () => createActor(SettingsMachine).start()
const ctx = (a: ReturnType<typeof start>) => a.getSnapshot().context

describe('settings', () => {
  it('starts metric / 24h', () => {
    const s = start()
    expect(ctx(s).units).toBe('metric')
    expect(ctx(s).clock).toBe('24h')
  })

  it('TOGGLE_UNITS flips metric <-> imperial', () => {
    const s = start()
    s.send({ type: 'TOGGLE_UNITS' })
    expect(ctx(s).units).toBe('imperial')
    s.send({ type: 'TOGGLE_UNITS' })
    expect(ctx(s).units).toBe('metric')
  })

  it('SET_UNITS validates its argument', () => {
    const s = start()
    s.send({ type: 'SET_UNITS', units: 'imperial' })
    expect(ctx(s).units).toBe('imperial')
    s.send({ type: 'SET_UNITS', units: 'nonsense' as never })
    expect(ctx(s).units).toBe('imperial') // rejected, unchanged
  })

  it('TOGGLE_CLOCK flips 24h <-> 12h', () => {
    const s = start()
    s.send({ type: 'TOGGLE_CLOCK' })
    expect(ctx(s).clock).toBe('12h')
    s.send({ type: 'TOGGLE_CLOCK' })
    expect(ctx(s).clock).toBe('24h')
  })
})
