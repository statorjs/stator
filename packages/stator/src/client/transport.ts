/**
 * Shared POST transport for the two `/__events` callers — the delegated page
 * runtime and island `dispatch()`. Lives apart from runtime.ts because that
 * module self-initializes on import; islands importing `dispatch` must not
 * drag the page runtime (and its document-wide listeners) into their bundle.
 *
 * Failure contract: network errors, timeouts, non-2xx responses and malformed
 * bodies resolve (never throw) as `{ ok: false, error }`, and a
 * `stator:dispatch-error` CustomEvent fires on window once per dispatch when
 * the failure is final.
 */

import type { WireEnvelope } from '../wire/index.ts'
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
  /** The server's `error` string, when the response body was JSON and had
   *  one; `'malformed response body'` for a 2xx that was not a JSON object.
   *  Absent for a non-JSON error body (a 500's text, a proxy's HTML page). */
  message?: string
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

/** The binding-layout fingerprint this page was rendered with, if it has one. */
export function pageLayout(): string | null | undefined {
  return document.querySelector('meta[name="stator-layout"]')?.getAttribute('content')
}

/** The route that rendered this page, when it was not the path's first match. */
export function pagePattern(): string | null | undefined {
  return document.querySelector('meta[name="stator-pattern"]')?.getAttribute('content')
}

/** `status` is 200 for any 2xx. A 422 is an answer only when its body carries
 *  a refusal; any other 422 is a failed request. */
export type PostEventResult =
  | { ok: true; status: 200 | 422; envelope: WireEnvelope }
  | { ok: false; error: DispatchError }

/** A response body parsed once: the JSON value, or `undefined` when the body
 *  is empty or not JSON. */
function parseBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A refusal is detected by its body, not the status alone: a JSON object
 *  whose `refusal` is an object with a string `code`. */
function carriesRefusal(body: unknown): boolean {
  return isObject(body) && isObject(body.refusal) && typeof body.refusal.code === 'string'
}

/** The `error` string of a parsed JSON error body, if it has one. A 400's
 *  `detail` is for the console, not for app code, so it is not read. */
function errorStringOf(body: unknown): string | undefined {
  return isObject(body) && typeof body.error === 'string' ? body.error : undefined
}

/** The `error` string of a JSON error body's text, if it has one. */
export function errorMessageOf(text: string): string | undefined {
  return errorStringOf(parseBody(text))
}

/**
 * POST an event descriptor to `/__events` and read the answer. Resolves —
 * never throws — and emits `stator:dispatch-error` once when a failure is
 * final. Network and timeout failures retry with backoff, but ONLY when the
 * body carries an `eventId` (the server's replay cache is what makes a
 * duplicate safe — keyed-list patches are not idempotent). A status is never
 * retried, a 422 included: the server saw the event and answered.
 *
 * The body is read for every status, in this order:
 *   - a 2xx with a JSON object is the envelope;
 *   - a 422 whose body carries a refusal is an envelope too (the machine was
 *     asked and said no), with nothing logged or emitted;
 *   - any other non-2xx is `phase: 'http'`, with the body's `error` string as
 *     `message` when it has one;
 *   - a 2xx whose body is not a JSON object is `phase: 'http'` with
 *     `message: 'malformed response body'`.
 */
export async function postEvent(
  body: { machine: string; event: { type: string }; eventId?: string },
  routeKey: string,
): Promise<PostEventResult> {
  let error: DispatchError
  const layout = pageLayout()
  const pattern = pagePattern()
  for (let attempt = 0; ; attempt++) {
    let res: Response
    let text: string
    try {
      res = await fetchWithTimeout('/__events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Stator-Route': routeKey,
          'X-Stator-Client': clientId,
          ...(layout ? { 'X-Stator-Layout': layout } : {}),
          ...(pattern ? { 'X-Stator-Pattern': pattern } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      // Read inside the try: a body cut off mid-read is an answer that did not
      // arrive, retried like a lost response (the replay cache answers it).
      text = await res.text()
    } catch (err) {
      error = { phase: err instanceof TimeoutError ? 'timeout' : 'network' }
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !body.eventId) {
        console.error('stator: network error during dispatch', err)
        break
      }
      console.warn(`stator: dispatch ${error.phase} — retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
      continue
    }

    const parsed = parseBody(text)
    if (res.ok) {
      if (isObject(parsed)) return { ok: true, status: 200, envelope: parsed as WireEnvelope }
      error = { phase: 'http', status: res.status, message: 'malformed response body' }
      console.error('stator: malformed response body', res.status, text)
      break
    }
    if (res.status === 422 && carriesRefusal(parsed)) {
      return { ok: true, status: 422, envelope: parsed as WireEnvelope }
    }
    const message = errorStringOf(parsed)
    error = { phase: 'http', status: res.status, ...(message !== undefined ? { message } : {}) }
    // The console gets everything the server said, a 400's `detail` included.
    console.error('stator: event POST failed', res.status, parsed ?? text)
    break
  }
  emitDispatchError(error, body)
  return { ok: false, error }
}
