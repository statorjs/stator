import { defineApiRoute } from '../../../../src/server/routing.ts'

export const GET = defineApiRoute({
  method: 'GET',
  handler: (request) => ({ user: request.claims<{ userId: string }>()?.userId ?? null }),
})
