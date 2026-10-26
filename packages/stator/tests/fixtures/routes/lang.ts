import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'

/** Reads a request header — the response varies per visitor. */
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => html`
    <html>
      <body>
        <p>${request.headers.get('accept-language') ?? 'none'}</p>
      </body>
    </html>
  `,
})
