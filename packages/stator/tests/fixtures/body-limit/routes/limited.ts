import { defineApiRoute } from '../../../../src/server/routing.ts'

// Separate limits per method on one URL.
export const POST = defineApiRoute({
  maxBodyBytes: 4096,
  handler: async (request) => Response.json({ size: (await request.text()).length }),
})

export const PUT = defineApiRoute({
  maxBodyBytes: 64,
  handler: async (request) => Response.json({ size: (await request.text()).length }),
})
