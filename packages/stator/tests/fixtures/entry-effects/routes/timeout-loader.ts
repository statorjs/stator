import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import TimeoutLoader from '../machines/timeout-loader.ts'

export const GET = defineRoute({
  reads: [TimeoutLoader],
  render: ({ TimeoutLoaderMachine: loader }: any) => html`
    <html>
      <body>
        <p>Status: ${read(loader, (s) => s.status)}</p>
      </body>
    </html>
  `,
})
