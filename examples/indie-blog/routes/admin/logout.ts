import { defineApiRoute } from '@statorjs/stator/server'
import OwnerMachine from '../../machines/owner.ts'

export const POST = defineApiRoute({
  reads: [OwnerMachine],
  handler: async (_request, { dispatch, rotateSession }) => {
    await dispatch(OwnerMachine, { type: 'LOGOUT' })
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
