import { defineApiRoute } from '../../../src/server/routing.ts'

/** Cookie-jar fixture: read an inbound cookie, write a couple back, and return
 *  NO directive — so an HTML client takes the 204 path (proves cookies survive
 *  it). */
export const POST = defineApiRoute({
  reads: [],
  handler: async (_request, { cookies }) => {
    const pref = cookies.get('pref')
    cookies.set('seen', 'yes', { path: '/', httpOnly: true })
    if (pref) cookies.set('echoed', pref, { path: '/' })
    return { directives: [] }
  },
})
