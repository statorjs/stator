import { defineMachine } from '@statorjs/stator/server'
import { cleanSignature } from '../lib/rules.ts'

type VisitorContext = {
  /** How many times this session has signed — powers the "thanks" note. */
  signedCount: number
}

type VisitorEvents = { type: 'SIGN'; name: string; message: string }

/** Per-visitor state. Client events land here first; the shared book picks
 *  up the SIGNED emit through its cross-machine subscription. */
export default defineMachine({
  name: 'VisitorMachine',
  lifecycle: 'session',
  events: {} as VisitorEvents,

  emits: {
    SIGNED: {
      payload: (_ctx: VisitorContext, ev: { name: string; message: string }) => ({
        name: ev.name,
        message: ev.message,
      }),
    },
  },

  context: { signedCount: 0 } as VisitorContext,
  initial: 'idle',
  states: {
    idle: {
      on: {
        SIGN: {
          do: (ctx, ev) => {
            if (cleanSignature(ev.name, ev.message)) ctx.signedCount += 1
          },
          emit: 'SIGNED',
        },
      },
    },
  },

  selectors: {
    signedCount: (ctx) => ctx.signedCount,
    hasSigned: (ctx) => ctx.signedCount > 0,
  },
})
