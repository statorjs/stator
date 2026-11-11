import { defineRoute } from '../../../../../src/server/routing.ts'
import { html } from '../../../../../src/template/html.ts'
import { read } from '../../../../../src/template/read.ts'
import Orders from '../../machines/orders.ts'

/** A members-only live page. It carries no guard of its own: the app gates
 *  `/admin` in middleware.ts, the way guides/middleware.md shows. */
export const GET = defineRoute({
  reads: [Orders],
  live: true,
  render: ({ OrdersMachine: orders }: any) => html`
    <html>
      <body>
        <p>Latest: ${read(orders, (o) => o.latest)}</p>
      </body>
    </html>
  `,
})
