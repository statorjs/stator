import { defineRoute } from '../../../../src/server/routing.ts'
import { on } from '../../../../src/template/directives/on.ts'
import { html } from '../../../../src/template/html.ts'
import Cart from '../machines/cart.ts'

export const GET = defineRoute({
  reads: [Cart],
  render: ({ CartMachine: cart }: any) =>
    html`<button ${on('click', () => cart.send({ type: 'CLEAR' }))}>clear</button>`,
})
