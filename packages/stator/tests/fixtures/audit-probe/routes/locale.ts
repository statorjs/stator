import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

/** Varies by a request header read through `request.raw` and by the request's
 *  host (`request.url`), neither of which the caching proof tracks. */
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => html`
    <html>
      <body>
        <p>lang:${request.raw.headers.get('accept-language') ?? 'none'}</p>
        <a href="${new URL('/reset', request.url).href}">reset</a>
      </body>
    </html>
  `,
})
