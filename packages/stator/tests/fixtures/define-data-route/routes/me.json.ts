import { defineDataRoute } from '../../../../src/server/routing.ts'

// Reads claims, so it is never marked cacheable.
export const GET = defineDataRoute({
  handler: (request) => ({ user: request.claims<{ userId: string }>()?.userId ?? null }),
})
