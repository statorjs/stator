import { defineApiRoute } from '../../../../src/server/routing.ts'

export const POST = defineApiRoute({
  maxBodyBytes: Infinity,
  handler: async (request) => Response.json({ size: (await request.text()).length }),
})
