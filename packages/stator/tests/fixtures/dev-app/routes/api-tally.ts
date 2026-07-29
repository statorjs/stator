import { defineApiRoute } from '@statorjs/stator/server'
import Tally from '../machines/tally.ts'

// Dev-parity fixture: a data GET route served through the Vite loader.
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Tally],
  handler: (_request, { machines }: any) => ({
    total: machines.TallyMachine.total,
  }),
})
