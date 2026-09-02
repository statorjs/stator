import { defineRoute } from '@statorjs/stator/server'
import { html, read } from '@statorjs/stator/template'
import Tally from '../machines/tally.ts'

/** A live page WITH a `<head>` — `tally.ts` has none, so head injection (the
 *  live/build metas, the dev client) has nothing to attach to there. This is
 *  the fixture for anything that asserts on injected head content. */
export const GET = defineRoute({
  reads: [Tally],
  live: true,
  render: ({ TallyMachine: tally }: any) => html`
    <html>
      <head>
        <title>live-head</title>
      </head>
      <body>
        <p>Total: ${read(tally, (t) => t.total)}</p>
      </body>
    </html>
  `,
})
