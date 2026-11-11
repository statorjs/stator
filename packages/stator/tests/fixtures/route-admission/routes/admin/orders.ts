import { defineRoute } from '../../../../../src/server/routing.ts'
import { on } from '../../../../../src/template/directives/on.ts'
import { html } from '../../../../../src/template/html.ts'
import { read } from '../../../../../src/template/read.ts'
import Orders from '../../machines/orders.ts'
import Prefs from '../../machines/prefs.ts'

/** A members-only live page. It carries no guard of its own: the app gates
 *  `/admin` in middleware.ts, the way guides/middleware.md shows. */
export const GET = defineRoute({
  reads: [Orders, Prefs],
  live: true,
  render: ({ OrdersMachine: orders, PrefsMachine: prefs }: any) => html`
    <html>
      <body>
        <p>Latest: ${read(orders, (o) => o.latest)}</p>
        <button ${on('click', () => prefs.send({ type: 'SET', theme: 'dark' }))}>Dark</button>
      </body>
    </html>
  `,
})
