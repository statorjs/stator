import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defineMachine } from '../src/engine/define-machine.ts'
import { describeMachine } from '../src/engine/describe.ts'

type SourceEvents = { type: 'PING' }
const Source = defineMachine({
  name: 'SourceMachine',
  lifecycle: 'app',
  events: {} as SourceEvents,
  emits: ['pinged'],
  context: {},
  initial: 'idle',
  states: { idle: { on: { PING: { emit: 'pinged' } } } },
})

type Events =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'DONE'; result: string }
  | { type: 'POKED' }
  | { type: 'EXPIRE' }

const Machine = defineMachine({
  name: 'DescribedMachine',
  lifecycle: 'session',
  events: {} as Events,
  serverOnly: ['DONE'],
  emits: { started: { payload: (ctx) => ({ at: ctx.startedAt }) }, stopped: null },
  reads: [Source],
  subscribes: [
    { from: Source, event: 'pinged', dispatch: 'POKED' },
    { from: Source, event: 'pinged', dispatch: { type: 'POKED', nudge: true } },
  ],
  context: { startedAt: 0, runs: 0 },
  initial: 'idle',
  states: {
    idle: {
      on: {
        // Ordered guarded candidates: first whose guard passes wins.
        START: [
          {
            to: 'running',
            when: (ctx) => ctx.runs < 3,
            do: (ctx) => {
              ctx.runs += 1
            },
            emit: ['started'],
            effect: async (): Promise<Events | null> => ({ type: 'DONE', result: 'ok' }),
          },
          { to: 'spent' },
        ],
      },
    },
    running: {
      entry: async (): Promise<Events | null> => null,
      after: [
        { delay: 50, send: { type: 'EXPIRE' } },
        { delay: (ctx) => ctx.runs * 10, send: { type: 'STOP' } },
      ],
      on: {
        DONE: { to: 'idle', emit: 'stopped' },
        // Bare function sugar for `{ do: fn }`.
        POKED: (ctx) => {
          ctx.runs += 0
        },
      },
    },
    spent: {},
  },
  // Machine-level fallback, consulted when the state declares nothing.
  on: { STOP: { to: 'idle' } },
  selectors: { runs: (ctx) => ctx.runs },
})

describe('describeMachine', () => {
  const d = describeMachine(Machine)

  it('carries the def-level facts', () => {
    assert.equal(d.name, 'DescribedMachine')
    assert.equal(d.lifecycle, 'session')
    assert.equal(d.persist, false)
    assert.equal(d.initial, 'idle')
    assert.deepStrictEqual(d.serverOnly, ['DONE'])
    assert.deepStrictEqual(d.emits.sort(), ['started', 'stopped'])
    assert.deepStrictEqual(d.selectors, ['runs'])
    assert.deepStrictEqual(d.reads, ['SourceMachine'])
    assert.deepStrictEqual(d.context, { startedAt: 0, runs: 0 })
  })

  it('normalizes subscribes to names (string and object dispatch forms)', () => {
    assert.deepStrictEqual(d.subscribes, [
      { from: 'SourceMachine', event: 'pinged', dispatch: 'POKED' },
      { from: 'SourceMachine', event: 'pinged', dispatch: 'POKED' },
    ])
  })

  it('describes ordered guarded candidates', () => {
    assert.deepStrictEqual(d.states.idle!.on.START, [
      { to: 'running', guarded: true, action: true, emits: ['started'], effect: true },
      { to: 'spent', guarded: false, action: false, emits: [], effect: false },
    ])
  })

  it('normalizes a bare action function to an unguarded self-transition', () => {
    assert.deepStrictEqual(d.states.running!.on.POKED, [
      { guarded: false, action: true, emits: [], effect: false },
    ])
  })

  it('reports entry and after (numeric and dynamic delays)', () => {
    assert.equal(d.states.idle!.entry, false)
    assert.equal(d.states.running!.entry, true)
    assert.deepStrictEqual(d.states.running!.after, [
      { delay: 50, send: 'EXPIRE' },
      { delay: 'dynamic', send: 'STOP' },
    ])
  })

  it('carries machine-level fallbacks and the handled-event union', () => {
    assert.deepStrictEqual(d.on.STOP, [
      { to: 'idle', guarded: false, action: false, emits: [], effect: false },
    ])
    assert.deepStrictEqual(d.events, ['DONE', 'POKED', 'START', 'STOP'])
  })

  it('is JSON-serializable (closures stay behind)', () => {
    assert.doesNotThrow(() => JSON.stringify(d))
    assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), d)
  })
})
