import { defineMachine } from '../../../src/server/define-machine.ts'

/** Fixture: session-scoped keyed list — the double-delivery probe (a live
 *  page dispatching an insert must not receive the row twice). */
export default defineMachine({
  name: 'ListMachine',
  lifecycle: 'session',
  events: {} as { type: 'ADD'; id: string },
  context: { items: [] as string[] },
  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD: {
          do: (ctx, ev) => {
            ctx.items.push(ev.id)
          },
        },
      },
    },
  },
  selectors: { items: (ctx) => ctx.items },
})
