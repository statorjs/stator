import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

/** A page for `/__events` to name. */
export const GET = defineRoute({
  reads: [],
  render: () => html`<html><body><p>page</p></body></html>`,
})
