import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import Ping from '../machines/ping.ts'

/** Live route over a SESSION machine — the surface the Plimsoll checkout
 *  exposed: fan-out must rehydrate the connection's session actors. */
export const GET = defineRoute({
  reads: [Ping],
  live: true,
  render: ({ PingMachine: ping }: any) => html`
    <html>
      <body>
        <p>sent: ${read(ping, (p: { sent: number }) => p.sent)}</p>
      </body>
    </html>
  `,
})
