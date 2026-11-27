import { defineApiRoute } from '../../../src/server/routing.ts'

// A command route that declares its method, and one that does not.
export const DELETE = defineApiRoute({
  method: 'DELETE',
  handler: () => ({}),
})

export const PUT = defineApiRoute({
  handler: () => ({}),
})
