import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Auth from '../machines/auth.ts'
import Board from '../machines/board.ts'

// A session machine's value read once, then branched on with a plain conditional.
export const GET = defineRoute({
  reads: [Auth, Board],
  live: true,
  render: ({ AuthMachine: auth, BoardMachine: board }: any) => {
    const signedIn = auth.signedIn
    return html`<!doctype html>
<html><head><title>t</title></head><body>
${
  signedIn
    ? html`<p id="member" title="${read(board, (b: any) => `members:${b.members}`)}">Signed in. Members online: ${read(board, (b: any) => b.members)}</p>`
    : html`<p id="anon">Sign in</p>`
}
<p id="total" title="${read(board, (b: any) => `total:${b.total}`)}">Total: ${read(board, (b: any) => b.total)}</p>
</body></html>`
  },
})
