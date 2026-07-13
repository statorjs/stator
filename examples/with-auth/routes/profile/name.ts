import { defineApiRoute } from '@statorjs/stator/server'
import AuthMachine from '../../machines/auth.ts'

export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(AuthMachine, { type: 'SET_NAME', name: String(form.get('name') ?? '') })
    return { directives: [{ type: 'navigate', to: '/profile' }] }
  },
})
