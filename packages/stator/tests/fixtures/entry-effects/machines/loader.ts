import { defineMachine } from '../../../../src/server/define-machine.ts'

// Module-level counter so the HTTP test can assert the entry effect fired
// exactly once across two requests (once on the fresh GET, never on hydration).
let entryFires = 0
export const loaderEntryFires = (): number => entryFires
export const resetLoaderEntryFires = (): void => {
  entryFires = 0
}

type Events = { type: 'LOADED'; items: string[] }

export default defineMachine({
  name: 'LoaderMachine',
  lifecycle: 'session',
  events: {} as Events,
  context: { items: [] as string[] },
  initial: 'loading',
  states: {
    loading: {
      entry: async (_ctx, _meta): Promise<Events | null> => {
        entryFires += 1
        return { type: 'LOADED', items: ['x', 'y'] }
      },
      on: {
        LOADED: {
          to: 'ready',
          do: (ctx, ev) => {
            ctx.items = ev.items
          },
        },
      },
    },
    ready: {},
  },
  selectors: { items: (ctx) => ctx.items },
})
