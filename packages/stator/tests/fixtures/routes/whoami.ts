import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'

/** Peeks at claims from a page. Anonymous and claims-less visitors see the
 *  same page; a signed-in visitor sees their user id at the same URL. */
export const GET = defineRoute({
  reads: [],
  render: (_ctx, request) => {
    const claims = request.claims<{ userId: string }>()
    return html`
      <html>
        <body>
          <p>${claims?.userId ?? 'anonymous'}</p>
        </body>
      </html>
    `
  },
})
