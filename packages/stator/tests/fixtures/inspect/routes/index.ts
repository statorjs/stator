import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import CounterMachine from '../machines/counter.ts'

export const GET = defineRoute({
  reads: [CounterMachine],
  live: true,
  render: (ctx) => {
    const counter = ctx.CounterMachine as { count: number }
    return html`<!doctype html><html><body><p>Count: <span>${counter.count}</span></p></body></html>`
  },
})
