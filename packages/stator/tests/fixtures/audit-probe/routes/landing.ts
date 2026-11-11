import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

/** An anonymous page: no reads, no session use. */
export const GET = defineRoute({
  reads: [],
  render: () => html`
    <html>
      <body>
        <p>landing</p>
      </body>
    </html>
  `,
})
