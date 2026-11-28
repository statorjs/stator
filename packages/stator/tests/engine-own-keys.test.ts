import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor, defineMachine } from '../src/engine/index.ts'

// Handler and state lookups read own properties only. An event whose type names
// an `Object.prototype` member is not handled unless the machine declares it.

const PROTOTYPE_NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']

type Events = { type: 'GO' } | { type: 'RESET' } | { type: 'toString' } | { type: 'valueOf' }

/** An event the machine's type does not admit, as an outside caller could send. */
const ev = (type: string): Events => ({ type }) as unknown as Events

// Handlers at both levels, so the state-level and the machine-level lookups are
// both exercised by an event neither declares.
const Plain = defineMachine({
  name: 'Plain',
  lifecycle: 'session',
  events: {} as Events,
  context: { n: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        GO: {
          to: 'done',
          do: (ctx) => {
            ctx.n += 1
          },
        },
      },
    },
    done: {},
  },
  on: { RESET: { to: 'idle' } },
})

describe('engine: lookups ignore Object.prototype', () => {
  for (const type of PROTOTYPE_NAMES) {
    it(`an event of type "${type}" is not handled`, () => {
      const actor = createActor(Plain).start()
      let notified = 0
      actor.subscribe(() => {
        notified += 1
      })
      const before = actor.getSnapshot()
      const result = actor.send(ev(type))
      assert.deepEqual(result, { committed: false })
      assert.equal(Object.hasOwn(result, 'refusal'), false)
      assert.equal(actor.getCommitCount(), 0)
      assert.equal(notified, 0)
      assert.deepEqual(actor.getSnapshot().value, before.value)
      assert.deepEqual(actor.getSnapshot().context, { n: 0 })
    })
  }

  it('the same holds in a state with no `on` map at all', () => {
    const actor = createActor(Plain).start()
    actor.send({ type: 'GO' })
    assert.deepEqual(actor.getSnapshot().value, ['done'])
    for (const type of PROTOTYPE_NAMES) {
      assert.deepEqual(actor.send(ev(type)), { committed: false })
    }
    assert.equal(actor.getCommitCount(), 1)
  })

  it('a handler the machine really declares under a prototype name still fires', () => {
    const Declared = defineMachine({
      name: 'Declared',
      lifecycle: 'session',
      events: {} as Events,
      context: { n: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            toString: {
              to: 'done',
              do: (ctx) => {
                ctx.n += 1
              },
            },
          },
        },
        done: {},
      },
      on: {
        valueOf: {
          do: (ctx) => {
            ctx.n += 10
          },
        },
      },
    })
    const actor = createActor(Declared).start()
    assert.deepEqual(actor.send({ type: 'toString' }), { committed: true })
    assert.deepEqual(actor.getSnapshot().value, ['done'])
    // Machine-level, declared: handled from a state that has none of its own.
    assert.deepEqual(actor.send(ev('valueOf')), { committed: true })
    assert.deepEqual(actor.getSnapshot().context, { n: 11 })
    // Undeclared prototype names are still refused next to the declared ones.
    assert.deepEqual(actor.send(ev('constructor')), { committed: false })
    assert.equal(actor.getCommitCount(), 2)
  })

  it('seed() rejects a prototype name as a state', () => {
    for (const state of PROTOTYPE_NAMES) {
      const actor = createActor(Plain)
      assert.throws(() => actor.seed({}, state), /does not have/)
    }
  })

  it('a hydrated snapshot whose state is a prototype name handles no event', () => {
    for (const state of PROTOTYPE_NAMES) {
      const actor = createActor(Plain, { snapshot: { value: [state], context: { n: 0 } } }).start()
      assert.deepEqual(actor.send(ev('toString')), { committed: false })
      // The machine-level handler still applies, as for any state without its own.
      assert.deepEqual(actor.send(ev('RESET')), { committed: true })
      assert.deepEqual(actor.getSnapshot().value, ['idle'])
    }
  })
})
