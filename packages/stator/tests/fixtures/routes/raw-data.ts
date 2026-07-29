import { defineApiRoute } from '../../../src/server/routing.ts'

// A raw Response from a data route passes through verbatim — status,
// headers, body all the handler's own.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () =>
    new Response('raw-bytes', {
      status: 201,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Fixture': 'yes' },
    }),
})
