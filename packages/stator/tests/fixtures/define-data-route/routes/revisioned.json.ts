import { defineDataRoute } from '../../../../src/server/routing.ts'

// The revision is a counter the test controls; the handler counts its runs,
// so a test can prove a revision match answers 304 without running it.
export const state = { revision: 1, handlerRuns: 0 }

export const GET = defineDataRoute({
  revision: () => state.revision,
  handler: () => {
    state.handlerRuns += 1
    return { runs: state.handlerRuns }
  },
})
