import { defineRoute } from '../../../../src/server/routing.ts'
import { defer } from '../../../../src/template/defer.ts'
import { html } from '../../../../src/template/html.ts'

/** A page that defers a slow lookup and renders the looked-up text. The text
 *  stands in for stored user content (a review, a comment); here it comes from
 *  the query string so the test can vary it. */
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => html`
    <html>
      <head><title>Reviews</title></head>
      <body>
        <h1>HEADING</h1>
        ${defer(async () => request.query.text ?? '', {
          ready: (text) => html`<blockquote>${text}</blockquote>`,
        })}
        <footer>FOOTER</footer>
      </body>
    </html>
  `,
})
