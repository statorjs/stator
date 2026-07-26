/**
 * Per-page-load identity, sent on the SSE connect AND on every dispatch —
 * fan-out uses it to recognize a dispatch's own connection and advance its
 * diff baseline WITHOUT re-sending patches the POST response already
 * delivered (text/attr dupes are invisible; keyed inserts are not).
 */
export const clientId: string =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c${Math.random().toString(36).slice(2)}`

/** Per-dispatch idempotency key: the server replays a duplicate POST's cached
 *  response instead of re-applying it, which is what makes retrying a lost
 *  response safe. Stable across retries of the SAME dispatch, never reused. */
export function newEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `e${Math.random().toString(36).slice(2)}`
}
