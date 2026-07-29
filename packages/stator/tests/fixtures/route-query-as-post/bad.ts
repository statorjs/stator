import { defineApiRoute } from '../../../src/server/routing.ts'

// Deliberately wrong: a method: 'GET' definition exported as POST. The
// declared method must match the export name.
export const POST = defineApiRoute({
  method: 'GET',
  handler: () => ({ nope: true }),
})
