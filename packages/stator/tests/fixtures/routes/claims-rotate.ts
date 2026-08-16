import { defineApiRoute } from '../../../src/server/routing.ts'

/** Login-shaped: set claims then rotate. Claims must follow to the new id. */
export const POST = defineApiRoute({
  reads: [],
  handler: async (_request, { setClaims, rotateSession }) => {
    setClaims({ userId: 'u1' })
    rotateSession()
    return { directives: [] }
  },
})
