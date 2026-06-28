import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import CounterMachine from '../machines/counter.ts'

// A full document that does NOT hand-include the client runtime — the framework
// auto-injects it. Pairs with index.ts (which still carries the manual tag) to
// cover both auto-injection and idempotency.
export const GET = defineRoute({
  reads: [CounterMachine],
  render: () => html`
    <!doctype html>
    <html>
      <body>
        <h1>Plain</h1>
      </body>
    </html>
  `,
})
