import { defineRoute } from '@statorjs/stator/server'
import { html } from '@statorjs/stator/template'

export const GET = defineRoute({
  reads: [],
  render: () => html`<!doctype html><html><body>ok</body></html>`,
})
