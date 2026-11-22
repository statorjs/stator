import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Board from '../machines/board.ts'

// shift.ts without `live`.
export const GET = defineRoute({
  reads: [Board],
  render: ({ BoardMachine: board }: any, request) => {
    const claims = request.claims<{ userId: string }>()
    return html`<!doctype html>
<html><head><title>t</title></head><body>
${
  claims
    ? html`<p id="member" title="${read(board, (b: any) => `members:${b.members}`)}">Members online: ${read(board, (b: any) => b.members)}</p>`
    : html`<p id="anon">Sign in</p>`
}
<p id="total" title="${read(board, (b: any) => `total:${b.total}`)}">Total: ${read(board, (b: any) => b.total)}</p>
</body></html>`
  },
})
