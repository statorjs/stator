// Type-level tests: a data GET route's `reads:` tuple flows into the handler's
// `machines`, so `machines.<Name>` is a typed read proxy (not `unknown`) and a
// mistyped machine name is a compile error. Regression for the data-route
// typing gap (the POC worked around it with `as InstanceOf<typeof Sites>`).
// Checked by `tsc --noEmit`; run via the package `typecheck` script.
import { defineApiRoute } from '../src/server/index.ts'
import CounterMachine from './fixtures/machines/counter.ts'

// `machines.CounterMachine` is a typed proxy: its selectors resolve to their
// declared return types, no cast needed.
defineApiRoute({
  method: 'GET',
  reads: [CounterMachine],
  handler: (_req, { machines }) => {
    const n: number = machines.CounterMachine.count
    const s: string = machines.CounterMachine.label
    return { n, s }
  },
})

// A selector's return type is enforced — assigning it to the wrong type fails.
defineApiRoute({
  method: 'GET',
  reads: [CounterMachine],
  handler: (_req, { machines }) => {
    // @ts-expect-error count is a number, not a string
    const wrong: string = machines.CounterMachine.count
    return { wrong }
  },
})

// A machine not in `reads:` is not on `machines` — a typo is a compile error,
// not a silent `unknown`.
defineApiRoute({
  method: 'GET',
  reads: [CounterMachine],
  handler: (_req, { machines }) => {
    // @ts-expect-error CounterMachien is misspelled / not in reads
    machines.CounterMachien.count
    return {}
  },
})

// No `reads:` → `machines` is empty; accessing any name is a compile error.
defineApiRoute({
  method: 'GET',
  handler: (_req, { machines }) => {
    // @ts-expect-error nothing was declared in reads
    machines.CounterMachine
    return {}
  },
})
