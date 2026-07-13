import { defineApiRoute } from '../../../src/server/routing.ts'
import Submitter from '../machines/submitter.ts'

/** Logout-shaped rotation: the old session's state is deleted. */
export const POST = defineApiRoute({
  reads: [Submitter],
  handler: async (_request, { rotateSession }) => {
    rotateSession({ clear: true })
    return { directives: [] }
  },
})
