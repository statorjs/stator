import { defineApiRoute } from '@statorjs/stator/server'
import AuthMachine from '../../machines/auth.ts'

/**
 * Logout: rotate with `clear: true` — the old session's state is DELETED
 * (the safe default on a shared computer) and the browser continues on a
 * fresh anonymous id. The LOGOUT dispatch is technically redundant (the
 * state is about to be deleted) but keeps the machine's chart honest.
 */
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (_request, { dispatch, rotateSession }) => {
    await dispatch(AuthMachine, { type: 'LOGOUT' })
    rotateSession({ clear: true })
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
