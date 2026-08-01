// SPIKE (child-machine composition gate): can a reusable, GENERIC machine carry
// full end-to-end inference? The load-bearing question for the whole composition
// track. Hypothesis: a reusable machine is just a factory that closes over an
// INJECTED effect and returns defineMachine(...), with the payload/result types
// woven through events/context/selectors. This file passes iff that hypothesis
// holds — checked by `tsc --noEmit`.
import { defineMachine } from '../src/server/define-machine.ts'
import type { InstanceOf } from '../src/template/types.ts'

/**
 * A reusable async-operation machine: idle → running → settled | failed, with
 * retry. Generic over what you SUBMIT (`TPayload`) and what you get back
 * (`TResult`). The actual async I/O is INJECTED (`op`) — the machine defines the
 * workflow shape, not the operation. This is the `AsyncUpdate` primitive.
 */
function defineAsyncUpdate<TPayload, TResult>(
  name: string,
  op: (payload: TPayload) => Promise<TResult>,
) {
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
    context: {
      attempt: 0,
      error: '',
      result: null as TResult | null,
      last: null as TPayload | null,
    },
    initial: 'idle',
    states: {
      idle: {
        on: {
          SUBMIT: {
            to: 'running',
            do: (ctx, ev) => {
              ctx.last = ev.payload // ev.payload is TPayload
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
              ctx.result = ev.result // ev.result is TResult
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
            do: (ctx, ev) => {
              ctx.last = ev.payload
            },
            effect: (_ctx, ev) => run(ev.payload),
          },
        },
      },
    },
    selectors: {
      result: (ctx) => ctx.result, // TResult | null
      error: (ctx) => ctx.error,
      attempt: (ctx) => ctx.attempt,
    },
  })
}

// --- Instantiate with a concrete op: TPayload / TResult inferred FROM it. ---
const saveQty = defineAsyncUpdate(
  'save-qty',
  (p: { id: string; qty: number }): Promise<{ version: number }> =>
    Promise.resolve({ version: p.qty }),
)

declare const s: InstanceOf<typeof saveQty>

// (1) Result selector carries the injected op's return type.
const r: { version: number } | null = s.result

// (2) State is the async workflow's own state union (not `string`).
const okState: boolean = s.state === 'running'
// @ts-expect-error 'reddy' is not a state of AsyncUpdate
const badState: boolean = s.state === 'reddy'

// (3) send() checks the parameterized payload/result shapes.
s.send({ type: 'SUBMIT', payload: { id: 'a', qty: 5 } })
s.send({ type: 'OK', result: { version: 2 } })
// @ts-expect-error payload must match the injected op's parameter type
s.send({ type: 'SUBMIT', payload: { id: 'a' } })
// @ts-expect-error 'NOPE' is not an event of AsyncUpdate
s.send({ type: 'NOPE' })

void r
void okState
void badState
