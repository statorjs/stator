import { defineApiRoute } from '@statorjs/stator/server'
import AuthMachine from '../../machines/auth.ts'

/**
 * Login: credentials travel as a FORM (values → forms; events → intents),
 * and verification happens in AuthMachine's LOGIN guard — wrong password is
 * a guard drop, and there is no forgeable "set identity" event anywhere.
 * On success, rotate the session id (fixation defense).
 */
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch, rotateSession }) => {
    const form = await request.formData()
    const { committed } = await dispatch(AuthMachine, {
      type: 'LOGIN',
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    })
    if (!committed) {
      // Guard drop = wrong credentials. No rotation for a failed attempt.
      return { directives: [{ type: 'navigate', to: '/login?error=bad-credentials' }] }
    }
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
