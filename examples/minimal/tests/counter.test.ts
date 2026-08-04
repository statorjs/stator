import { createActor } from '@statorjs/stator/machine'
import { describe, expect, it } from 'vitest'
import CounterMachine from '../machines/counter.ts'

describe('counter', () => {
  it('starts at zero', () => {
    const actor = createActor(CounterMachine).start()
    expect(actor.getSnapshot().context.count).toBe(0)
  })

  it('INCREMENT adds one; RESET returns to zero', () => {
    const actor = createActor(CounterMachine).start()
    actor.send({ type: 'INCREMENT' })
    actor.send({ type: 'INCREMENT' })
    expect(actor.getSnapshot().context.count).toBe(2)

    actor.send({ type: 'RESET' })
    expect(actor.getSnapshot().context.count).toBe(0)
  })

  it('the label selector reflects the count', () => {
    const actor = createActor(CounterMachine).start()
    actor.send({ type: 'INCREMENT' })
    expect(CounterMachine.selectors.label(actor.getSnapshot().context)).toBe('count is 1')
  })
})
