import { defineApiRoute } from '@statorjs/stator/server'
import CartMachine from '../../machines/cart.ts'

export const POST = defineApiRoute({
  reads: [CartMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(CartMachine, {
      type: 'SET_CONTACT',
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
    })
    // The machine's guard decides whether the flow advanced; the page
    // re-renders whichever state it's actually in.
    return { directives: [{ type: 'navigate', to: '/checkout' }] }
  },
})
