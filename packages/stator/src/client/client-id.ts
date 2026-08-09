/**
 * Per-page-load identity, sent on the SSE connect AND on every dispatch —
 * fan-out uses it to recognize a dispatch's own connection and advance its
 * diff baseline WITHOUT re-sending patches the POST response already
 * delivered (text/attr dupes are invisible; keyed inserts are not).
 */
function freshId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c${Math.random().toString(36).slice(2)}`
}

/** One identity per PAGE, not per bundle. The page runtime (a classic-script
 *  bundle) and island modules (the Vite/asset graph) each carry their own copy
 *  of this module — a plain module-scoped id would mint one per copy, the SSE
 *  connection and an island's dispatch would disagree, and fan-out's
 *  originator skip would never fire (double-applying keyed inserts on the
 *  dispatching page). The window slot is the page-load singleton both copies
 *  converge on. */
export const clientId: string = (() => {
  if (typeof window === 'undefined') return freshId()
  const w = window as { __statorClientId?: string }
  w.__statorClientId ??= freshId()
  return w.__statorClientId
})()

/** Per-dispatch idempotency key: the server replays a duplicate POST's cached
 *  response instead of re-applying it, which is what makes retrying a lost
 *  response safe. Stable across retries of the SAME dispatch, never reused. */
export function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `e${Math.random().toString(36).slice(2)}`
}
