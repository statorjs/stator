import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Board from '../machines/board.ts'

// Claims feed only a text and an attribute value: same layout either way.
export const GET = defineRoute({
  reads: [Board],
  live: true,
  render: ({ BoardMachine: board }: any, request) => {
    const claims = request.claims<{ userId: string }>()
    return html`<!doctype html>
<html><head><title>t</title></head><body>
<p id="who" data-user="${claims?.userId ?? 'none'}">${claims?.userId ?? 'anonymous'}</p>
<p id="total">Total: ${read(board, (b: any) => b.total)}</p>
</body></html>`
  },
})
