import { defineApiRoute } from '../../../src/server/routing.ts'
import Submitter from '../machines/submitter.ts'

/** Rotation fixture: dispatch (so touched-state persists) then rotate —
 *  the login-shaped flow. */
export const POST = defineApiRoute({
  reads: [Submitter],
  handler: async (_request, { dispatch, rotateSession }) => {
    await dispatch(Submitter, { type: 'POKE' })
    rotateSession()
    return { directives: [] }
  },
})
