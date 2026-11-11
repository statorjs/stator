import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Prefs from '../machines/prefs.ts'

export const GET = defineRoute({
  reads: [Prefs],
  render: ({ PrefsMachine: prefs }: any) => html`
    <html>
      <body>
        <p>Theme: ${read(prefs, (p) => p.theme)}</p>
      </body>
    </html>
  `,
})
