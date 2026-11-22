import { defineApiRoute } from '../../../../src/server/routing.ts'
import Auth from '../machines/auth.ts'

export const POST = defineApiRoute({
  reads: [Auth],
  handler: async (_request, h) => {
    await h.dispatch(Auth, { type: 'LOGOUT' })
    h.clearClaims()
    return { directives: [] }
  },
})
