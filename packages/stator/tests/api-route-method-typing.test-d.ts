// Type-level tests: `method` on defineApiRoute. `'GET'` picks the data-route
// overload (`{ machines }`); no method or any other method picks the command
// overload (`{ dispatch, rotateSession }`). Checked by `tsc --noEmit`; run via
// the package `typecheck` script.
import { defineApiRoute, type HttpMethod } from '../src/server/index.ts'
import CounterMachine from './fixtures/machines/counter.ts'

// No method: a command route, exactly as before.
defineApiRoute({
  reads: [CounterMachine],
  handler: async (_req, { dispatch, rotateSession }) => {
    await dispatch(CounterMachine, { type: 'INCREMENT' })
    rotateSession()
    return {}
  },
})

// 'POST' and 'DELETE' resolve to the command overload.
defineApiRoute({
  method: 'POST',
  handler: (_req, { dispatch, rotateSession }) => {
    void dispatch
    void rotateSession
    return {}
  },
})
defineApiRoute({
  method: 'DELETE',
  handler: (_req, { dispatch }) => {
    void dispatch
    return {}
  },
})

// 'GET' resolves to the data-route overload.
defineApiRoute({
  method: 'GET',
  reads: [CounterMachine],
  handler: (_req, { machines }) => ({ n: machines.CounterMachine.count }),
})

// A command route has no `machines`.
defineApiRoute({
  method: 'POST',
  // @ts-expect-error Property 'machines' does not exist on type 'ApiRouteHelpers'
  handler: (_req, { machines }) => {
    void machines
    return {}
  },
})

// A data route has no `dispatch`.
defineApiRoute({
  method: 'GET',
  // @ts-expect-error Property 'dispatch' does not exist on type 'QueryRouteHelpers<readonly []>'
  handler: (_req, { dispatch }) => {
    void dispatch
    return {}
  },
})

// OPTIONS is not a route method.
// @ts-expect-error No overload matches this call
defineApiRoute({ method: 'OPTIONS', handler: () => ({}) })

// A method typed as the whole union has to be narrowed before the call.
declare const anyMethod: HttpMethod
// @ts-expect-error No overload matches this call
defineApiRoute({ method: anyMethod, handler: () => ({}) })
