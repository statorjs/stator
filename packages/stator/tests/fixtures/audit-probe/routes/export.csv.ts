import { defineApiRoute } from '../../../../src/server/routing.ts'

/** A data route returning a raw Response (the documented escape hatch). */
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => new Response('a,b\n1,2\n', { headers: { 'Content-Type': 'text/csv' } }),
})
