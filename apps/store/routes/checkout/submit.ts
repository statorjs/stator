import { defineApiRoute } from '@statorjs/stator/server'
import CartMachine from '../../machines/cart.ts'

export const POST = defineApiRoute({
  reads: [CartMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    // The token names a fake card; the AMOUNT is never client-supplied — the
    // machine's charge effect computes it from its own lines.
    await dispatch(CartMachine, {
      type: 'SUBMIT',
      token: String(form.get('token') ?? ''),
    })
    return { directives: [{ type: 'navigate', to: '/checkout' }] }
  },
})
