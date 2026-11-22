import { defineApiRoute } from '../../../../src/server/routing.ts'

export const POST = defineApiRoute({
  reads: [],
  handler: async (_request, { setClaims, rotateSession }) => {
    setClaims({ userId: 'u1' })
    rotateSession()
    return { directives: [] }
  },
})
