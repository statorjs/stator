import { defineRoute } from '../../../../src/server/routing.ts'
import { when } from '../../../../src/template/conditional.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Board from '../machines/board.ts'

// Claims branch through when(): the arm is slot-scoped.
export const GET = defineRoute({
  reads: [Board],
  live: true,
  render: ({ BoardMachine: board }: any, request) => {
    const claims = request.claims<{ userId: string }>()
    return html`<!doctype html>
<html><head><title>t</title></head><body>
${when(claims, () => html`<p id="member">Members online: ${read(board, (b: any) => b.members)}</p>`)}
<p id="total">Total: ${read(board, (b: any) => b.total)}</p>
</body></html>`
  },
})
