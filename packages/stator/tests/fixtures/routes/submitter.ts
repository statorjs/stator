import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import Submitter from '../machines/submitter.ts'

export const GET = defineRoute({
  reads: [Submitter],
  render: ({ SubmitterMachine: submitter }: any) => html`
    <html>
      <body>
        <p>Status: ${read(submitter, (s) => s.status)}</p>
        <p>Pokes: ${read(submitter, (s) => s.pokes)}</p>
      </body>
    </html>
  `,
})
