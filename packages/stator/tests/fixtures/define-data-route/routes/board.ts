import { defineApiRoute, defineDataRoute } from '../../../../src/server/routing.ts'
import Board from '../../machines/board.ts'

// A data GET built with defineDataRoute, beside a command POST in one file.
export const GET = defineDataRoute({
  reads: [Board],
  handler: (_request, { machines }) => ({ total: machines.BoardMachine.total }),
})

export const POST = defineApiRoute({
  handler: () => ({ directives: [] }),
})
