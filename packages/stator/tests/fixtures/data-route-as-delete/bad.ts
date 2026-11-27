import { defineDataRoute } from '../../../src/server/routing.ts'

// Deliberately wrong: a data route exported under a mutation method.
export const DELETE = defineDataRoute({
  handler: () => ({ nope: true }),
})
