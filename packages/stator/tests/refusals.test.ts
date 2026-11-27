import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createActor, defineMachine, type RefusalIssue } from '../src/engine/index.ts'

// Refused-dispatch reasons, engine half: a guard calls `helpers.refuse(code, …)`,
// which returns false; `send()` returns `{ committed, refusal? }`. A reason is
// transient data on the result, never machine state.

type Events =
  | { type: 'REGISTER'; email: string; seats: number }
  | { type: 'NOOP' }
  | { type: 'ELSEWHERE' }

const roster = ['ada@example.com']
const capacity = 4

const Desk = defineMachine({
  name: 'Desk',
  lifecycle: 'session',
  events: {} as Events,
  context: { taken: 0 },
  initial: 'open',
  states: {
    open: {
      on: {
        REGISTER: {
          when: (ctx, ev, { refuse }) => {
            if (!ev.email.includes('@'))
              return refuse('invalid', {
                issues: [{ path: ['email'], message: 'Enter an email address.' }],
              })
            if (roster.includes(ev.email))
              return refuse('duplicate', {
                issues: [{ path: ['email'], message: 'That email is already on the roster.' }],
              })
            if (ctx.taken + ev.seats > capacity)
              return refuse('full', { message: 'Not enough seats are left.' })
            return true
          },
          do: (ctx, ev) => {
            ctx.taken += ev.seats
          },
        },
        // A guard that refuses without a reason.
        NOOP: { when: () => false },
      },
    },
    closed: {},
  },
})

describe('engine: refusal reasons', () => {
  it('a committed send reports committed: true and no refusal', () => {
    const a = createActor(Desk).start()
    const r = a.send({ type: 'REGISTER', email: 'bo@example.com', seats: 2 })
    assert.deepStrictEqual(r, { committed: true })
    assert.equal(a.getSnapshot().context.taken, 2)
  })

  it('refuse() returns false and the result carries the refusal', () => {
    const a = createActor(Desk).start()
    const r = a.send({ type: 'REGISTER', email: 'ada@example.com', seats: 1 })
    assert.deepStrictEqual(r, {
      committed: false,
      refusal: {
        code: 'duplicate',
        issues: [{ path: ['email'], message: 'That email is already on the roster.' }],
      },
    })
    assert.equal(a.getCommitCount(), 0)
    assert.equal(a.getSnapshot().context.taken, 0)
  })

  it('a message-only refusal has no issues key, and the reason is not stored anywhere', () => {
    const a = createActor(Desk).start()
    const r = a.send({ type: 'REGISTER', email: 'bo@example.com', seats: 9 })
    assert.deepStrictEqual(r, {
      committed: false,
      refusal: { code: 'full', message: 'Not enough seats are left.' },
    })
    assert.deepStrictEqual(a.getPersistedSnapshot().context, { taken: 0 })
    assert.equal(JSON.stringify(a.getPersistedSnapshot()).includes('full'), false)
  })

  it('a guard returning false without refuse() is a bare refusal', () => {
    const a = createActor(Desk).start()
    assert.deepStrictEqual(a.send({ type: 'NOOP' }), { committed: false })
  })

  it('an event the current state does not handle carries no refusal', () => {
    const a = createActor(Desk).start()
    assert.deepStrictEqual(a.send({ type: 'ELSEWHERE' }), { committed: false })
  })

  it('each send starts with no refusal recorded', () => {
    const a = createActor(Desk).start()
    assert.equal(a.send({ type: 'REGISTER', email: 'x', seats: 1 }).refusal?.code, 'invalid')
    assert.deepStrictEqual(a.send({ type: 'NOOP' }), { committed: false })
    assert.deepStrictEqual(a.send({ type: 'REGISTER', email: 'bo@example.com', seats: 1 }), {
      committed: true,
    })
  })

  it('the first refusal recorded wins: across candidates and within one guard', () => {
    type E = { type: 'GO' }
    const M = defineMachine({
      name: 'FirstWins',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            GO: [
              {
                when: (_c, _e, { refuse }) => {
                  refuse('first', { message: 'one' })
                  return refuse('second')
                },
                to: 'a',
              },
              { when: (_c, _e, { refuse }) => refuse('third'), to: 'a' },
            ],
          },
        },
      },
    })
    const r = createActor(M).start().send({ type: 'GO' })
    assert.deepStrictEqual(r, { committed: false, refusal: { code: 'first', message: 'one' } })
  })

  it('a later candidate that passes drops the earlier refusal', () => {
    type E = { type: 'GO' }
    const M = defineMachine({
      name: 'LaterPasses',
      lifecycle: 'session',
      events: {} as E,
      context: { took: '' },
      initial: 'a',
      states: {
        a: {
          on: {
            GO: [
              {
                when: (_c, _e, { refuse }) => refuse('nope'),
                do: (c) => {
                  c.took = 'first'
                },
              },
              {
                do: (c) => {
                  c.took = 'fallback'
                },
              },
            ],
          },
        },
      },
    })
    const a = createActor(M).start()
    assert.deepStrictEqual(a.send({ type: 'GO' }), { committed: true })
    assert.equal(a.getSnapshot().context.took, 'fallback')
  })

  it('refuse() then return true commits with no refusal', () => {
    type E = { type: 'GO' }
    const M = defineMachine({
      name: 'ChangedMind',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            GO: {
              when: (_c, _e, { refuse }) => {
                refuse('maybe')
                return true
              },
              to: 'b',
            },
          },
        },
        b: {},
      },
    })
    const a = createActor(M).start()
    assert.deepStrictEqual(a.send({ type: 'GO' }), { committed: true })
    assert.deepStrictEqual(a.getSnapshot().value, ['b'])
  })

  it('composes as a boolean: refuse(...) && true is false', () => {
    type E = { type: 'GO'; n: number }
    const M = defineMachine({
      name: 'Composed',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            GO: {
              when: (_c, e, { refuse }) =>
                (e.n > 0 || refuse('negative')) && (e.n < 10 || refuse('too-big')),
              to: 'a',
            },
          },
        },
      },
    })
    const a = createActor(M).start()
    assert.equal(a.send({ type: 'GO', n: 5 }).committed, true)
    assert.deepStrictEqual(a.send({ type: 'GO', n: -1 }), {
      committed: false,
      refusal: { code: 'negative' },
    })
    assert.deepStrictEqual(a.send({ type: 'GO', n: 11 }), {
      committed: false,
      refusal: { code: 'too-big' },
    })
  })

  it('actions get no refuse helper', () => {
    type E = { type: 'GO' }
    let seen: unknown = 'unset'
    const M = defineMachine({
      name: 'ActionHelpersOnly',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            GO: {
              when: () => true,
              do: (_c, _e, h) => {
                seen = (h as unknown as Record<string, unknown>).refuse
              },
            },
          },
        },
      },
    })
    createActor(M).start().send({ type: 'GO' })
    assert.equal(seen, undefined)
  })

  it('guards keep the host-provided helpers beside refuse', () => {
    type E = { type: 'GO' }
    const M = defineMachine({
      name: 'WithReads',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            GO: {
              when: (_c, _e, { reads, refuse }) =>
                (reads as { Stock: { left: number } }).Stock.left > 0 || refuse('sold-out'),
              to: 'a',
            },
          },
        },
      },
    })
    const a = createActor(M, { resolveHelpers: () => ({ reads: { Stock: { left: 0 } } }) }).start()
    assert.deepStrictEqual(a.send({ type: 'GO' }), {
      committed: false,
      refusal: { code: 'sold-out' },
    })
  })

  it('holds a Standard Schema issue list after flattening its path', () => {
    // The Standard Schema v1 issue shape: path segments are a PropertyKey or
    // `{ key }`. Mapped by the caller, not the engine.
    type StandardIssue = {
      message: string
      path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
    }
    const schemaIssues: StandardIssue[] = [
      { message: 'Required', path: ['name'] },
      { message: 'Expected a number', path: [{ key: 'guests' }, 2, { key: 'age' }] },
      { message: 'Bad event' },
    ]
    const toIssue = (i: StandardIssue): RefusalIssue => ({
      message: i.message,
      path: (i.path ?? []).map((seg) => {
        const key = typeof seg === 'object' ? seg.key : seg
        return typeof key === 'number' ? key : String(key)
      }),
    })

    type E = { type: 'SUBMIT' }
    const M = defineMachine({
      name: 'Schema',
      lifecycle: 'session',
      events: {} as E,
      context: {},
      initial: 'a',
      states: {
        a: {
          on: {
            SUBMIT: {
              when: (_c, _e, { refuse }) =>
                refuse('invalid', { issues: schemaIssues.map(toIssue) }),
            },
          },
        },
      },
    })
    const r = createActor(M).start().send({ type: 'SUBMIT' })
    assert.deepStrictEqual(r, {
      committed: false,
      refusal: {
        code: 'invalid',
        issues: [
          { message: 'Required', path: ['name'] },
          { message: 'Expected a number', path: ['guests', 2, 'age'] },
          { message: 'Bad event', path: [] },
        ],
      },
    })
  })
})
