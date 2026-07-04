import { defineRoute } from '../../../src/server/routing.ts'
import { html } from '../../../src/template/html.ts'
import { read } from '../../../src/template/read.ts'
import Board from '../machines/board.ts'

export const GET = defineRoute({
  reads: [Board],
  live: true,
  render: ({ BoardMachine: board }: any) => html`
    <html>
      <body>
        <p>Total: ${read(board, (b) => b.total)}</p>
      </body>
    </html>
  `,
})
