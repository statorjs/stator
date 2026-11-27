import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import Prefs from '../machines/prefs.ts'

/** A page that renders a stored event field as plain text — the ordinary
 *  `{value}` interpolation, not a live read. */
export const GET = defineRoute({
  reads: [Prefs],
  render: ({ PrefsMachine: prefs }: any) => html`
    <html>
      <body>
        <p>THEME:${prefs.theme}</p>
      </body>
    </html>
  `,
})
