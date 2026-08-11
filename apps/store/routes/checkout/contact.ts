import { defineApiRoute } from '@statorjs/stator/server'
import CartMachine from '../../machines/cart.ts'

export const POST = defineApiRoute({
  reads: [CartMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const result = await dispatch(CartMachine, {
      type: 'SET_CONTACT',
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
    })
    // The machine's guard decides whether the flow advanced — but a refused
    // dispatch carries no reason on the wire, so the route names the step
    // that bounced and the page says so in that arm.
    return {
      directives: [
        { type: 'navigate', to: result.committed ? '/checkout' : '/checkout?refused=contact' },
      ],
    }
  },
})
