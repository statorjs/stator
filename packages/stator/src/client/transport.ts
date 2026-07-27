/**
 * Shared POST transport for the two `/__events` callers — the delegated page
 * runtime and island `dispatch()`. Lives apart from runtime.ts because that
 * module self-initializes on import; islands importing `dispatch` must not
 * drag the page runtime (and its document-wide listeners) into their bundle.
 *
 * Failure contract: network errors, timeouts, and non-2xx responses resolve
 * (never throw) as `{ ok: false, error }`, and a `stator:dispatch-error`
 * CustomEvent fires on window once per dispatch when the failure is final.
 */

import { clientId } from './client-id.ts'

/** App-level deadline for event POSTs — browsers' own connection timeouts are
 *  far too long to leave an interaction hanging on a flaky link. */
export const FETCH_TIMEOUT_MS = 10_000

/** Backoff before each retry of a network/timeout failure. Retries carry the
 *  same eventId, so a duplicate that actually reached the server replays. */
export const RETRY_DELAYS_MS = [300, 1000]

export interface DispatchError {
  phase: 'network' | 'timeout' | 'http'
  /** HTTP status — present only for `phase: 'http'`. */
  status?: number
}

/** Thrown by `fetchWithTimeout` when the deadline aborts the request, so
 *  callers can tell a dead-slow connection from an unreachable one. */
export class TimeoutError extends Error {
  constructor() {
    super(`request exceeded ${FETCH_TIMEOUT_MS}ms`)
    this.name = 'TimeoutError'
  }
}

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function emitDispatchError(
  error: DispatchError,
  context: { machine?: string; event?: { type: string } },
): void {
  emit('stator:dispatch-error', { ...context, ...error, timestamp: Date.now() })
}

/** `fetch` with the app-level deadline applied via AbortController. */
export async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, FETCH_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    throw timedOut ? new TimeoutError() : err
  } finally {
    clearTimeout(timer)
  }
}

export type PostEventResult = { ok: true; res: Response } | { ok: false; error: DispatchError }

/**
 * POST an event descriptor to `/__events`. Resolves — never throws — and
 * emits `stator:dispatch-error` once when a failure is final. Network and
 * timeout failures retry with backoff, but ONLY when the body carries an
 * `eventId` (the server's replay cache is what makes a duplicate safe —
 * keyed-list patches are not idempotent). Non-2xx responses are terminal
 * immediately: the server saw the event and answered.
 */
export async function postEvent(
  body: { machine: string; event: { type: string }; eventId?: string },
  routeKey: string,
): Promise<PostEventResult> {
  let error: DispatchError
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout('/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Stator-Route': routeKey,
          'X-Stator-Client': clientId,
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (res.ok) return { ok: true, res }
      error = { phase: 'http', status: res.status }
      console.error('stator: event POST failed', res.status, await res.text())
      break
    } catch (err) {
      error = { phase: err instanceof TimeoutError ? 'timeout' : 'network' }
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !body.eventId) {
        console.error('stator: network error during dispatch', err)
        break
      }
      console.warn(`stator: dispatch ${error.phase} — retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  emitDispatchError(error, body)
  return { ok: false, error }
}
