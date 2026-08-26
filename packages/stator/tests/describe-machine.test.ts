import { describe, expect, it } from 'vitest'
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
    expect(d.name).toBe('DescribedMachine')
    expect(d.lifecycle).toBe('session')
    expect(d.persist).toBe(false)
    expect(d.initial).toBe('idle')
    expect(d.serverOnly).toEqual(['DONE'])
    expect(d.emits.sort()).toEqual(['started', 'stopped'])
    expect(d.selectors).toEqual(['runs'])
    expect(d.reads).toEqual(['SourceMachine'])
    expect(d.context).toEqual({ startedAt: 0, runs: 0 })
  })

  it('normalizes subscribes to names (string and object dispatch forms)', () => {
    expect(d.subscribes).toEqual([
      { from: 'SourceMachine', event: 'pinged', dispatch: 'POKED' },
      { from: 'SourceMachine', event: 'pinged', dispatch: 'POKED' },
    ])
  })

  it('describes ordered guarded candidates', () => {
    expect(d.states.idle!.on.START).toEqual([
      { to: 'running', guarded: true, action: true, emits: ['started'], effect: true },
      { to: 'spent', guarded: false, action: false, emits: [], effect: false },
    ])
  })

  it('normalizes a bare action function to an unguarded self-transition', () => {
    expect(d.states.running!.on.POKED).toEqual([
      { guarded: false, action: true, emits: [], effect: false },
    ])
  })

  it('reports entry and after (numeric and dynamic delays)', () => {
    expect(d.states.idle!.entry).toBe(false)
    expect(d.states.running!.entry).toBe(true)
    expect(d.states.running!.after).toEqual([
      { delay: 50, send: 'EXPIRE' },
      { delay: 'dynamic', send: 'STOP' },
    ])
  })

  it('carries machine-level fallbacks and the handled-event union', () => {
    expect(d.on.STOP).toEqual([
      { to: 'idle', guarded: false, action: false, emits: [], effect: false },
    ])
    expect(d.events).toEqual(['DONE', 'POKED', 'START', 'STOP'])
  })

  it('is JSON-serializable (closures stay behind)', () => {
    expect(() => JSON.stringify(d)).not.toThrow()
    expect(JSON.parse(JSON.stringify(d))).toEqual(d)
  })
})
