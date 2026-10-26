import { defineApiRoute } from '../../../src/server/routing.ts'

/** A data route that reads a request header. */
export const GET = defineApiRoute({
  method: 'GET',
  handler: (request) => ({ ua: request.headers.get('user-agent') ?? null }),
})
