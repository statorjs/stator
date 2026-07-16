import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import LoaderMachine from '../machines/loader.ts'

// Reading LoaderMachine is what pulls it into the runtime, so a fresh session's
// initial `loading` entry effect fires on the GET.
export const GET = defineRoute({
  reads: [LoaderMachine],
  render: () => html`<!doctype html><html><body><h1>Loader</h1></body></html>`,
})
