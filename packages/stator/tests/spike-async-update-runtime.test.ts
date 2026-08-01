// SPIKE (child-machine composition, runtime): the typing gate is green
// (spike-async-update.test-d.ts). This proves the AsyncUpdate machine actually
// RUNS end-to-end with its INJECTED effect — the op fires, the completion routes
// back through the event path, the workflow settles, and the result is readable.
// Uses createActor's local effect scheduling (onEffect omitted → the actor runs
// the effect on a microtask and sends its completion to itself).
import { describe, expect, it } from 'vitest'
import { createActor, defineMachine } from '../src/engine/index.ts'

/** The reusable generic async-op machine (same factory the typing spike proved). */
function defineAsyncUpdate<TPayload, TResult>(name: string, op: (p: TPayload) => Promise<TResult>) {
  type Events =
    | { type: 'SUBMIT'; payload: TPayload }
    | { type: 'OK'; result: TResult }
    | { type: 'FAIL'; error: string }
    | { type: 'RETRY'; payload: TPayload }

  const run = async (payload: TPayload): Promise<Events> => {
    try {
      return { type: 'OK', result: await op(payload) }
    } catch (e) {
      return { type: 'FAIL', error: String(e) }
    }
  }

  return defineMachine({
    name,
    lifecycle: 'session',
    events: {} as Events,
    context: { attempt: 0, error: '', result: null as TResult | null },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SUBMIT: {
            to: 'running',
            do: (ctx) => {
              ctx.attempt += 1
            },
            effect: (_ctx, ev) => run(ev.payload),
          },
        },
      },
      running: {
        on: {
          OK: {
            to: 'settled',
            do: (ctx, ev) => {
              ctx.result = ev.result
              ctx.error = ''
            },
          },
          FAIL: {
            to: 'failed',
            do: (ctx, ev) => {
              ctx.error = ev.error
            },
          },
        },
      },
      settled: {},
      failed: {
        on: {
          RETRY: {
            to: 'running',
            do: (ctx) => {
              ctx.attempt += 1
            },
            effect: (_ctx, ev) => run(ev.payload),
          },
        },
      },
    },
    selectors: {
      result: (ctx) => ctx.result,
      error: (ctx) => ctx.error,
      attempt: (ctx) => ctx.attempt,
    },
  })
}

/** Flush microtasks + the injected op's promise so the local effect completes. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AsyncUpdate runtime spike (injected effect runs end-to-end)', () => {
  it('SUBMIT → running → (op runs) → OK → settled, result readable', async () => {
    const save = defineAsyncUpdate('save', async (p: { qty: number }) => ({ version: p.qty + 1 }))
    const actor = createActor(save).start()
    expect(actor.getSnapshot().value).toEqual(['idle'])

    actor.send({ type: 'SUBMIT', payload: { qty: 5 } })
    expect(actor.getSnapshot().value).toEqual(['running']) // pending — effect in flight
    expect(actor.getSnapshot().context.attempt).toBe(1)

    await flush() // the injected op runs, OK routes back through the event path
    expect(actor.getSnapshot().value).toEqual(['settled'])
    expect(actor.getSnapshot().context.result).toEqual({ version: 6 })
  })

  it('the injected op throwing routes to FAIL → failed', async () => {
    const save = defineAsyncUpdate('save', async () => {
      throw new Error('boom')
    })
    const actor = createActor(save).start()
    actor.send({ type: 'SUBMIT', payload: {} })
    await flush()
    expect(actor.getSnapshot().value).toEqual(['failed'])
    expect(actor.getSnapshot().context.error).toContain('boom')
  })

  it('RETRY from failed re-runs the op and settles', async () => {
    let firstCall = true
    const save = defineAsyncUpdate('save', async (p: { n: number }) => {
      if (firstCall) {
        firstCall = false
        throw new Error('transient')
      }
      return { doubled: p.n * 2 }
    })
    const actor = createActor(save).start()

    actor.send({ type: 'SUBMIT', payload: { n: 3 } })
    await flush()
    expect(actor.getSnapshot().value).toEqual(['failed'])

    actor.send({ type: 'RETRY', payload: { n: 3 } })
    await flush()
    expect(actor.getSnapshot().value).toEqual(['settled'])
    expect(actor.getSnapshot().context.result).toEqual({ doubled: 6 })
    expect(actor.getSnapshot().context.attempt).toBe(2)
  })
})
