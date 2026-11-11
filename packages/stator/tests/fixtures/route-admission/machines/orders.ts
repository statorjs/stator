import { defineMachine } from '../../../../src/server/define-machine.ts'

/** Shared (app-lifecycle) back-office data: every session sees the same instance. */
type Events = { type: 'ADD'; note: string }

export default defineMachine({
  name: 'OrdersMachine',
  lifecycle: 'app',
  events: {} as Events,
  context: { notes: ['order 1001: Ada Lovelace, 12 Analytical Row'] },
  initial: 'ready',
  states: {
    ready: {
      on: {
        ADD: (ctx, ev) => {
          ctx.notes.push(ev.note)
        },
      },
    },
  },
  selectors: { latest: (ctx) => ctx.notes[ctx.notes.length - 1] },
})
