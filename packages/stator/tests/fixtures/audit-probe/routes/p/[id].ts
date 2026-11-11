import { defineRoute } from '../../../../../src/server/routing.ts'
import { html } from '../../../../../src/template/html.ts'

export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => html`
    <html>
      <body>
        <p>${request.params.id}</p>
      </body>
    </html>
  `,
})
