import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import BootCounter from '../machines/counter.ts'

export const GET = defineRoute({
  reads: [BootCounter],
  render: (ctx) => {
    const counter = ctx.BootCounter as { count: number }
    return html`<!doctype html><html><body><p>Count: <span>${counter.count}</span></p></body></html>`
  },
})
