import { defineRoute } from '../../../../src/server/routing.ts'
import { when } from '../../../../src/template/conditional.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Auth from '../machines/auth.ts'
import Board from '../machines/board.ts'

// The documented shape: identity read from a session machine through when(read()).
export const GET = defineRoute({
  reads: [Auth, Board],
  live: true,
  render: ({ AuthMachine: auth, BoardMachine: board }: any) => html`<!doctype html>
<html><head><title>t</title></head><body>
${when(
  read(auth, (a: any) => a.signedIn),
  () =>
    html`<p id="member" title="${read(board, (b: any) => `members:${b.members}`)}">Signed in as ${read(auth, (a: any) => a.name)}. Members online: ${read(board, (b: any) => b.members)}</p>`,
)}
${when(
  read(auth, (a: any) => !a.signedIn),
  () => html`<p id="anon">Sign in</p>`,
)}
<p id="total" title="${read(board, (b: any) => `total:${b.total}`)}">Total: ${read(board, (b: any) => b.total)}</p>
</body></html>`,
})
