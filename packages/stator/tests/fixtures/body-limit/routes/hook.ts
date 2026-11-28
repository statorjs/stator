import { defineApiRoute } from '../../../../src/server/routing.ts'

// A route the middleware reads the body for; its own limit applies there too.
export const POST = defineApiRoute({
  maxBodyBytes: 32,
  handler: () => new Response('handler'),
})
