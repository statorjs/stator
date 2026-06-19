import { defineApiRoute } from '../../../src/server/routing.ts'
import CounterMachine from '../machines/counter.ts'

// Exercises typed, def-mediated dispatch: the machine is addressed by its
// imported def (not a string), and the event is type-checked against
// CounterMachine's event union.
export const POST = defineApiRoute({
  reads: [CounterMachine],
  handler: async (_request, { dispatch }) => {
    await dispatch(CounterMachine, { type: 'INCREMENT' })
    return { directives: [] }
  },
})
