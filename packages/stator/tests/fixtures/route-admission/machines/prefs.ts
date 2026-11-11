import { defineMachine } from '../../../../src/server/define-machine.ts'

/** A session machine the public page dispatches to. Its action stores the
 *  event's fields as they arrive. */
type Events = { type: 'SET'; theme: string }

export default defineMachine({
  name: 'PrefsMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { theme: 'light' },
  initial: 'ready',
  states: {
    ready: {
      on: {
        SET: (ctx, ev) => {
          ctx.theme = ev.theme
        },
      },
    },
  },
  selectors: { theme: (ctx) => ctx.theme },
})
