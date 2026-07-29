import { defineApiRoute } from '../../../src/server/routing.ts'
import Board from '../machines/board.ts'

// Data GET route: extensionless URL, plain-value return → JSON.
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Board],
  handler: (_request, { machines }: any) => ({
    total: machines.BoardMachine.total,
  }),
})

// Coexists with a command in the same file — one URL, two capabilities.
export const POST = defineApiRoute({
  handler: () => ({ directives: [] }),
})
