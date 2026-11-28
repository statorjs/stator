import type { DispatchError, DispatchResult } from '../src/client/index.ts'

/**
 * Type-level contract for `DispatchResult` (checked by `tsc` over the test
 * tree; the assertions are compile-time). It is a union on `ok`: a failure
 * always carries its `error`, and a success never does.
 */

declare const result: DispatchResult

if (!result.ok) {
  // Narrowed to the failure arm: `error` is present, no `!` or re-check.
  const error: DispatchError = result.error
  const committed: false = result.committed
  const patchCount: 0 = result.patchCount
  void [error, committed, patchCount]
} else {
  const none: undefined = result.error
  const committed: boolean = result.committed
  void [none, committed]
}

// Un-narrowed reads and destructuring still work, as they did on the interface.
const { ok, committed, patchCount, error } = result
const maybe: DispatchError | undefined = error
void [ok, committed, patchCount, maybe]

const success: DispatchResult = { ok: true, committed: true, patchCount: 2 }
const failure: DispatchResult = {
  ok: false,
  committed: false,
  patchCount: 0,
  error: { phase: 'network' },
}
void [success, failure]

// @ts-expect-error a failure must carry its error
const missingError: DispatchResult = { ok: false, committed: false, patchCount: 0 }
const errorOnSuccess: DispatchResult = {
  ok: true,
  committed: true,
  patchCount: 0,
  // @ts-expect-error a success cannot carry an error
  error: { phase: 'http' },
}
// @ts-expect-error a failure never committed
const committedFailure: DispatchResult = {
  ok: false,
  committed: true,
  patchCount: 0,
  error: { phase: 'http' },
}
void [missingError, errorOnSuccess, committedFailure]
