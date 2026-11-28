// Type-level tests: defineDataRoute takes the data-route fields of
// defineApiRoute without `method`, and types its handler the same way.
// Checked by `tsc --noEmit`; run via the package `typecheck` script.
import {
  type DefineDataRouteConfig,
  defineApiRoute,
  defineDataRoute,
  type QueryRouteDefinition,
} from '../src/server/index.ts'
import CounterMachine from './fixtures/machines/counter.ts'

// `machines` is typed off `reads`: selectors resolve to their return types.
const def: QueryRouteDefinition = defineDataRoute({
  reads: [CounterMachine],
  handler: (_req, { machines }) => {
    const n: number = machines.CounterMachine.count
    const s: string = machines.CounterMachine.label
    // @ts-expect-error count is a number, not a string
    const wrong: string = machines.CounterMachine.count
    // @ts-expect-error CounterMachien is misspelled / not in reads
    machines.CounterMachien.count
    return { n, s, wrong }
  },
  revision: () => 1,
})
void def

// No `reads` → `machines` is empty.
defineDataRoute({
  handler: (_req, { machines }) => {
    // @ts-expect-error nothing was declared in reads
    machines.CounterMachine
    return {}
  },
})

// Read-only: there is no `dispatch` (or any command helper) on a data route.
defineDataRoute({
  reads: [CounterMachine],
  // @ts-expect-error Property 'dispatch' does not exist on type 'QueryRouteHelpers'
  handler: (_req, { dispatch }) => dispatch,
})

// A data route may return a Response, a string, or a JSON value.
defineDataRoute({ handler: () => new Response('ok') })
defineDataRoute({ handler: () => 'text' })
defineDataRoute({ handler: async () => ({ ok: true }) })

// `method` is not a field: the export name is GET.
defineDataRoute({
  // @ts-expect-error 'method' does not exist in type 'DefineDataRouteConfig'
  method: 'GET',
  handler: () => ({}),
})

// `maxBodyBytes` is not a field: a data GET has no body.
defineDataRoute({
  // @ts-expect-error 'maxBodyBytes' does not exist in type 'DefineDataRouteConfig'
  maxBodyBytes: 1024,
  handler: () => ({}),
})

// The config type is exported and is what defineDataRoute takes.
const config: DefineDataRouteConfig<readonly [typeof CounterMachine]> = {
  reads: [CounterMachine],
  handler: (_req, { machines }) => ({ n: machines.CounterMachine.count }),
}
defineDataRoute(config)

// Command routes are unchanged: no `method` field, `dispatch` is there.
defineApiRoute({
  reads: [CounterMachine],
  handler: async (_req, { dispatch }) => {
    await dispatch(CounterMachine, { type: 'INCREMENT' })
    return { directives: [] }
  },
})
// @ts-expect-error No overload matches this call: a command route has no `method`
defineApiRoute({ method: 'POST', handler: () => ({ directives: [] }) })
