import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import Board from '../machines/board.ts'

// A live route with a real <head> — so the framework's meta injection
// (stator-live / stator-build) has a `</head>` boundary to land at.
export const GET = defineRoute({
  reads: [Board],
  live: true,
  render: ({ BoardMachine: board }: any) => html`
    <!doctype html>
    <html>
      <head><title>Live</title></head>
      <body><p>Total: ${read(board, (b) => b.total)}</p></body>
    </html>
  `,
})
