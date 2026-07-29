import { defineApiRoute } from '../../../src/server/routing.ts'
import Ping from '../machines/ping.ts'

// Data GET over a SESSION machine: hydrates the requesting cookie's own
// state — two sessions see two different answers at one URL.
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Ping],
  handler: (_request, { machines }: any) => ({
    sent: machines.PingMachine.sent,
  }),
})
