import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

// Stand-in for a login page: somewhere to navigate to and come Back from.
export const GET = defineRoute({
  reads: [],
  render: () => html`<!doctype html>
<html><head><title>elsewhere</title></head><body><p id="elsewhere">elsewhere</p></body></html>`,
})
