import { defineApiRoute } from '../../../src/server/routing.ts'

// Deliberately mis-constructed: GET must be a defineRoute. This file's ONLY
// export is the bad GET — discovery must throw the mismatch error, not treat
// the file as a non-route utility and skip it (the skip surfaces as an
// unexplained 404 and a dev banner counting one route short).
export const GET = defineApiRoute({
  handler: () => new Response('unreachable'),
})
