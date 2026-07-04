import { defineMachine } from '../../../src/server/define-machine.ts'

/**
 * Effects fixture: SUBMIT commits 'pending' synchronously, then an effect
 * simulates I/O (a short timer) and completes with DONE or FAILED. `shouldFail`
 * on the SUBMIT event steers the outcome; `delayMs` widens the I/O window so
 * tests can prove the session lock isn't held across it.
 */
type Events =
  | { type: 'SUBMIT'; shouldFail?: boolean; delayMs?: number }
  | { type: 'DONE'; receipt: string }
  | { type: 'FAILED'; reason: string }
  | { type: 'POKE' }

export default defineMachine({
  name: 'SubmitterMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { receipt: '', reason: '', pokes: 0, lastEffectId: '' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        SUBMIT: {
          to: 'pending',
          effect: async (_ctx, ev, meta) => {
            await new Promise((r) => setTimeout(r, ev.delayMs ?? 10))
            return ev.shouldFail
              ? { type: 'FAILED', reason: 'declined' }
              : { type: 'DONE', receipt: `r-${meta.effectId}` }
          },
        },
        POKE: (ctx) => {
          ctx.pokes += 1
        },
      },
    },
    pending: {
      on: {
        DONE: {
          to: 'confirmed',
          do: (ctx, ev) => {
            ctx.receipt = ev.receipt
          },
        },
        FAILED: {
          to: 'idle',
          do: (ctx, ev) => {
            ctx.reason = ev.reason
          },
        },
        POKE: (ctx) => {
          ctx.pokes += 1
        },
      },
    },
    confirmed: {
      on: {
        POKE: (ctx) => {
          ctx.pokes += 1
        },
      },
    },
  },
  selectors: {
    status: (ctx) =>
      ctx.receipt ? `confirmed:${ctx.receipt}` : ctx.reason ? `failed:${ctx.reason}` : 'waiting',
    pokes: (ctx) => ctx.pokes,
  },
})
