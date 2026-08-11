import { defineApiRoute } from '@statorjs/stator/server'
import OwnerMachine from '../../machines/owner.ts'

/** Login, the with-auth shape: credentials as a form, verification in the
 *  LOGIN guard, session rotation on success (fixation defense). */
export const POST = defineApiRoute({
  reads: [OwnerMachine],
  handler: async (request, { dispatch, rotateSession }) => {
    const form = await request.formData()
    const { committed } = await dispatch(OwnerMachine, {
      type: 'LOGIN',
      password: String(form.get('password') ?? ''),
    })
    if (!committed) {
      return { directives: [{ type: 'navigate', to: '/admin?error=bad-password' }] }
    }
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/admin' }] }
  },
})
