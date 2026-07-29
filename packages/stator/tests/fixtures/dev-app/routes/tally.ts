import { defineRoute } from '@statorjs/stator/server'
import { html, read } from '@statorjs/stator/template'
import Tally from '../machines/tally.ts'

export const GET = defineRoute({
  reads: [Tally],
  live: true,
  render: ({ TallyMachine: tally }: any) => html`
    <html>
      <body>
        <p>Total: ${read(tally, (t) => t.total)}</p>
      </body>
    </html>
  `,
})
