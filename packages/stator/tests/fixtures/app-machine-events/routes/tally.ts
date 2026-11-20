import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import TallyMachine from '../machines/tally.ts'

export const GET = defineRoute({
  reads: [TallyMachine],
  render: (ctx) => {
    const tally = ctx.TallyMachine as { count: number }
    return html`<!doctype html><html><body><p>Count: <span>${tally.count}</span></p></body></html>`
  },
})
