import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import Ping from '../machines/ping.ts'

export const GET = defineRoute({
  reads: [Ping],
  render: ({ PingMachine: ping }: any) => html`
    <html>
      <body>
        <p>Sent: ${read(ping, (p) => p.sent)}</p>
      </body>
    </html>
  `,
})
