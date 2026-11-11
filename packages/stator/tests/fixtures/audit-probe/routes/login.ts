import { defineApiRoute } from '../../../../src/server/routing.ts'

/** Login-shaped command: mint claims, rotate, and answer with a raw Response
 *  (`?raw=1`) or with the directives envelope. */
export const POST = defineApiRoute({
  handler: (request, { setClaims, rotateSession }) => {
    setClaims({ userId: 'u1' })
    rotateSession()
    if (request.query.raw) {
      return new Response(null, { status: 303, headers: { Location: '/' } })
    }
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
