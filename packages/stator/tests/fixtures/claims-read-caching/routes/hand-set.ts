import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

// Reads claims and sets its own Cache-Control.
export const GET = defineRoute({
  reads: [],
  render: ({ response }, request) => {
    response.headers.set('Cache-Control', 'public, s-maxage=30')
    return html`<p>${request.claims<{ userId: string }>()?.userId ?? 'anonymous'}</p>`
  },
})
