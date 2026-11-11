import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor } from '../src/engine/index.ts'

/**
 * A client `machine()` definition is plain data and tests like a server one:
 * importing the client entry needs no DOM.
 */
describe('client entry without a DOM', () => {
  it('imports, and a machine() definition runs under createActor', async () => {
    assert.equal(typeof globalThis.HTMLElement, 'undefined')
    const { machine, StatorElement } = await import('../src/client/index.ts')
    const Qty = machine(
      { count: 1 },
      {
        on: {
          INC: (s) => {
            s.count += 1
          },
        },
        select: { doubled: (s) => s.count * 2 },
      },
    )
    const actor = createActor(Qty)
    actor.start()
    actor.send({ type: 'INC' })
    assert.equal(actor.getSnapshot().context.count, 2)

    assert.throws(() => new StatorElement(), /needs a DOM.*@env happy-dom/)
  })
})
