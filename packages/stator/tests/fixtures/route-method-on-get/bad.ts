import { defineApiRoute } from '../../../src/server/routing.ts'

// Deliberately wrong: a command route declaring method: 'POST', exported as GET.
export const GET = defineApiRoute({
  method: 'POST',
  handler: () => new Response('unreachable'),
})
