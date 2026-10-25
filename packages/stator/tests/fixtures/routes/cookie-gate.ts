import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'

/** Parses the Cookie header by hand (a marker-cookie gate). The read itself
 *  is what counts, whether or not the cookie arrived. */
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => {
    const previewing = /(?:^|;\s*)preview=/.test(request.headers.get('cookie') ?? '')
    return html`
      <html>
        <body>
          <p>${previewing ? 'draft' : 'live'}</p>
        </body>
      </html>
    `
  },
})
