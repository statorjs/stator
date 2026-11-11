import { defineApiRoute } from '../../../../src/server/routing.ts'

/** A command route that takes a while (an upload being read, a slow upstream). */
export const POST = defineApiRoute({
  handler: async () => {
    await new Promise((r) => setTimeout(r, 400))
    return { directives: [] }
  },
})
