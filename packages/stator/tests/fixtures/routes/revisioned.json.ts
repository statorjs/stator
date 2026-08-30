import { defineApiRoute } from '../../../src/server/routing.ts'

// Revision-ledger fixture: the revision is a cheap counter the TEST controls;
// the handler counts its own invocations so a test can prove a revision
// match answers 304 WITHOUT running it.
export const state = { revision: 1, handlerRuns: 0 }

export const GET = defineApiRoute({
  method: 'GET',
  revision: () => state.revision,
  handler: () => {
    state.handlerRuns += 1
    return { runs: state.handlerRuns }
  },
})
