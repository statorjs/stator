import { defineApiRoute } from '@statorjs/stator/server'
import { findUserByEmail } from '../../lib/db.ts'
import AuthMachine from '../../machines/auth.ts'

/**
 * Login: credentials travel as a FORM (values → forms; events → intents),
 * and verification happens in AuthMachine's LOGIN guard — wrong password is
 * a guard drop, and there is no forgeable "set identity" event anywhere.
 *
 * On success we do three things: mirror a minimal identity into session CLAIMS
 * (so the machine-unaware middleware can gate the members' area — see
 * `middleware.ts`), rotate the session id (fixation defense), and bounce back
 * to wherever the visitor was headed (the `returnTo` the middleware stashed).
 */
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch, rotateSession, setClaims, cookies }) => {
    const form = await request.formData()
    const email = String(form.get('email') ?? '')
    const { committed } = await dispatch(AuthMachine, {
      type: 'LOGIN',
      email,
      password: String(form.get('password') ?? ''),
    })
    if (!committed) {
      // Guard drop = wrong credentials. No rotation, no claims for a failure.
      return { directives: [{ type: 'navigate', to: '/login?error=bad-credentials' }] }
    }

    // The claim is a PROJECTION of AuthMachine's truth, minted from the same DB
    // row the guard authenticated against — never from the client's event.
    const user = findUserByEmail(email)
    if (user) setClaims({ userId: user.id, role: user.role })
    rotateSession()

    // Return the visitor to the page that bounced them here, if any. Only
    // same-origin relative paths — never an absolute/`//host` open redirect.
    const returnTo = cookies.get('returnTo')
    cookies.delete('returnTo', { path: '/' })
    const to = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
    return { directives: [{ type: 'navigate', to }] }
  },
})
