import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'

// App machines boot regardless of routes; this trivial route just gives
// createApp a routes directory to discover.
export const GET = defineRoute({
  reads: [],
  render: () => html`<!doctype html><html><body><h1>App lifecycle</h1></body></html>`,
})
