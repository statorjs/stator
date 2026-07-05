import { defineApiRoute } from '@statorjs/stator/server'
import CartMachine from '../../machines/cart.ts'

export const POST = defineApiRoute({
  reads: [CartMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(CartMachine, {
      type: 'SET_SHIPPING',
      address: String(form.get('address') ?? ''),
      port: String(form.get('port') ?? ''),
    })
    return { directives: [{ type: 'navigate', to: '/checkout' }] }
  },
})
