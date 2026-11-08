import { createActor } from '@statorjs/stator/machine'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import CounterMachine from '../machines/counter.ts'

describe('counter', () => {
  it('starts at zero', () => {
    const actor = createActor(CounterMachine).start()
    assert.equal(actor.getSnapshot().context.count, 0)
  })

  it('INCREMENT adds one; RESET returns to zero', () => {
    const actor = createActor(CounterMachine).start()
    actor.send({ type: 'INCREMENT' })
    actor.send({ type: 'INCREMENT' })
    assert.equal(actor.getSnapshot().context.count, 2)

    actor.send({ type: 'RESET' })
    assert.equal(actor.getSnapshot().context.count, 0)
  })

  it('the label selector reflects the count', () => {
    const actor = createActor(CounterMachine).start()
    actor.send({ type: 'INCREMENT' })
    assert.equal(CounterMachine.selectors.label(actor.getSnapshot().context), 'count is 1')
  })
})
