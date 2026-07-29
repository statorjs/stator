import { defineApiRoute } from '../../../src/server/routing.ts'

export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ({ ok: true }),
})
