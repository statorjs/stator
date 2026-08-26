import { defineApiRoute } from '../../../../src/server/routing.ts'
import TickerMachine from '../machines/ticker.ts'

// A data GET route — shows up in the inspect payload as kind 'data'.
export const GET = defineApiRoute({
  method: 'GET',
  reads: [TickerMachine],
  handler: (_req, { machines }) => ({ ticks: machines.TickerMachine.ticks }),
})
