import { defineApiRoute } from '../../../../src/server/routing.ts'
import Board from '../../machines/board.ts'

// The same data GET in the deprecated spelling, for side-by-side comparison.
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Board],
  handler: (_request, { machines }) => ({ total: machines.BoardMachine.total }),
})
