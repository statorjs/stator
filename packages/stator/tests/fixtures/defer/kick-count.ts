// Module-level counter so a test can assert a defer thunk fires exactly once on
// a cold GET and is never re-run on the /__events re-diff.
let kicks = 0
export const deferKicks = (): number => kicks
export const bumpDeferKicks = (): void => {
  kicks += 1
}
export const resetDeferKicks = (): void => {
  kicks = 0
}
