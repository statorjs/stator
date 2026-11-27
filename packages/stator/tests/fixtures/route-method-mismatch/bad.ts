import { defineApiRoute } from '../../../src/server/routing.ts'

// Deliberately wrong: a method: 'POST' definition exported as DELETE. The
// declared method must match the export name.
export const DELETE = defineApiRoute({
  method: 'POST',
  handler: () => ({}),
})
