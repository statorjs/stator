/**
 * stator client runtime.
 *
 * Responsibilities:
 *   1. Attach delegated event listeners on document.body for a fixed set of
 *      DOM event types. On fire, look for the nearest ancestor carrying
 *      `data-event-<type>="..."` and POST the JSON descriptor to /__events.
 *   2. Intercept form submissions: when the form has a `data-event-submit`
 *      descriptor, follow the descriptor path; otherwise POST the form's
 *      FormData to its `action` URL.
 *   3. Apply patches in the response according to the wire protocol — see
 *      WIRE.md. Two target kinds (slot, element) × three ops (text, html,
 *      attr) currently implemented.
 *   4. Apply directives (navigate, reload, etc.) after patches.
 *   5. Dispatch `stator:*` CustomEvents on `window` at protocol edges so
 *      inspectors and devtools can observe the traffic without monkey-
 *      patching. See "Observability hooks" below for the contract.
 */

import { applyDirectives, applyPatches } from '../wire/apply.ts'
import type { WireEnvelope } from '../wire/index.ts'
import { clientId, newEventId } from './client-id.ts'
import { emitDispatchError, fetchWithTimeout, postEvent, TimeoutError } from './transport.ts'

const EVENT_TYPES = ['click', 'submit', 'change', 'input'] as const

/* ------------------------------------------------------------------ */
/* In-flight affordance                                                */
/* ------------------------------------------------------------------ */

/** `data-stator-pending` marks the element whose event POST is in flight
 *  (CSS hook: `[data-stator-pending]`). Counted per element so rapid repeat
 *  dispatches keep the attribute until the LAST one settles. */
const pendingCounts = new WeakMap<Element, number>()

function beginPending(el: Element): void {
  pendingCounts.set(el, (pendingCounts.get(el) ?? 0) + 1)
  el.setAttribute('data-stator-pending', '')
}

function endPending(el: Element): void {
  const count = (pendingCounts.get(el) ?? 1) - 1
  if (count <= 0) {
    pendingCounts.delete(el)
    el.removeAttribute('data-stator-pending')
  } else {
    pendingCounts.set(el, count)
  }
}

/* ------------------------------------------------------------------ */
/* Observability hooks                                                 */
/* ------------------------------------------------------------------ */

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/* ------------------------------------------------------------------ */
/* Event delegation + dispatch                                         */
/* ------------------------------------------------------------------ */

function init(): void {
  for (const type of EVENT_TYPES) {
    document.body.addEventListener(type, handleEvent)
  }
  initLiveChannel()
}

function initLiveChannel(): { close(): void } | undefined {
  const meta = document.querySelector('meta[name="stator-live"][content="true"]')
  if (!meta) return

  const routeKey = `GET ${location.pathname}${location.search}`
  // Echo the build this page was rendered against (if any) so the server can
  // reload us when it's serving a newer build (dev restart / deploy). Baked
  // into the URL at load time, so it rides EventSource's native reconnect too.
  const build = document.querySelector('meta[name="stator-build"]')?.getAttribute('content')
  const buildParam = build ? `&build=${encodeURIComponent(build)}` : ''
  const url = `/__sse?route=${encodeURIComponent(routeKey)}&client=${encodeURIComponent(clientId)}${buildParam}`

  // Connection-state signal: `data-stator-connection` on the root element
  // (CSS hook for offline banners etc.) plus a `stator:connection-state`
  // event. Change-guarded — EventSource fires `error` on every failed
  // auto-reconnect attempt, and only transitions are worth announcing.
  let connectionState: string | undefined
  const setConnectionState = (state: 'connected' | 'disconnected' | 'stale'): void => {
    if (state === connectionState) return
    connectionState = state
    document.documentElement.setAttribute('data-stator-connection', state)
    emit('stator:connection-state', { state, timestamp: Date.now() })
  }

  let sse: EventSource | null = null
  let lastSeen = Date.now()

  const onMessage = (e: MessageEvent): void => {
    lastSeen = Date.now()
    let data: WireEnvelope
    try {
      data = JSON.parse(e.data)
    } catch (err) {
      console.error('stator: malformed SSE message', err)
      return
    }
    if (data.patches) {
      // SSE is server-pushed — no client round-trip to time — so report the
      // apply duration (still the useful "how expensive was this update?").
      const startedAt = performance.now()
      applyPatches(data.patches)
      emit('stator:patches-received', {
        patches: data.patches,
        source: 'sse',
        durationMs: Math.round(performance.now() - startedAt),
        timestamp: Date.now(),
      })
    }
    if (data.directives && data.directives.length > 0) {
      applyDirectives(data.directives)
    }
  }

  // Reconnect = resync, never reload. Every fresh /__sse connection gets the
  // server's initial sync (every binding's current value, keyed lists reset
  // wholesale), so a rebuilt channel converges the DOM in place — and the
  // browser's own auto-reconnect on the same instance re-runs that server
  // path too, its sync arriving as an ordinary message. Directives fired
  // during an outage (e.g. a navigate) are not replayed; resync converges
  // state only.
  const connect = (): void => {
    sse?.close()
    const es = new EventSource(url, { withCredentials: true })
    sse = es
    lastSeen = Date.now() // fresh grace period — no instant re-stale loop
    es.addEventListener('open', () => setConnectionState('connected'))
    es.addEventListener('message', onMessage)
    es.addEventListener('error', () => {
      setConnectionState('disconnected')
      if (es.readyState === EventSource.CLOSED) {
        console.warn('stator: SSE permanently closed')
      }
    })
  }

  // Zombie watchdog. A half-open connection (device sleep, silent NAT drop)
  // never fires `error` — EventSource just sits "open" and silent forever,
  // and the page quietly stops being live. The server sends an observable
  // ping every 25s; two missed pings while the page is VISIBLE means the
  // channel is dead, and a rebuilt connection re-syncs. Hidden tabs wait for
  // visibility — no churn for pages nobody is watching.
  const STALE_MS = 65_000
  const checkStale = (): void => {
    if (document.hidden) return
    if (Date.now() - lastSeen > STALE_MS) {
      console.warn('stator: SSE channel stale — reconnecting to re-sync')
      setConnectionState('stale')
      connect()
    }
  }
  const watchdog = setInterval(checkStale, 10_000)
  document.addEventListener('visibilitychange', checkStale)

  connect()

  return {
    close(): void {
      clearInterval(watchdog)
      document.removeEventListener('visibilitychange', checkStale)
      sse?.close()
    },
  }
}

function handleEvent(e: Event): void {
  const target = e.target as Element | null
  if (!target) return

  // Form submissions: prefer data-event-submit descriptor if present,
  // otherwise intercept based on form's action attribute.
  if (e.type === 'submit') {
    const form = target.closest('form') as HTMLFormElement | null
    if (form) {
      const descriptorAttr = form.getAttribute('data-event-submit')
      if (descriptorAttr) {
        e.preventDefault()
        let descriptor: { machine: string; event: { type: string } }
        try {
          descriptor = JSON.parse(descriptorAttr)
        } catch {
          console.error('stator: malformed event descriptor on form', form, descriptorAttr)
          return
        }
        void dispatchEvent(descriptor, form)
        return
      }
      // Opt-in interception via `data-stator-enhance`. Plain forms without
      // the attribute submit normally — they may legitimately point at
      // third-party endpoints, or want browser-default behavior for SEO,
      // accessibility, or focus management. Auto-intercepting every form
      // would silently change HTML semantics in ways the developer never
      // asked for.
      if (
        form.hasAttribute('data-stator-enhance') &&
        form.action &&
        form.method.toLowerCase() === 'post'
      ) {
        e.preventDefault()
        void submitForm(form)
        return
      }
      // Fall through: nothing to intercept, browser default submit.
      return
    }
  }

  const attrName = `data-event-${e.type}`
  const el = target.closest(`[${attrName}]`)
  if (!el) return
  const raw = el.getAttribute(attrName)
  if (!raw) return

  let descriptor: { machine: string; event: { type: string } }
  try {
    descriptor = JSON.parse(raw)
  } catch {
    console.error('stator: malformed event descriptor on', el, raw)
    return
  }

  void dispatchEvent(descriptor, el)
}

async function dispatchEvent(
  descriptor: { machine: string; event: { type: string } },
  el?: Element,
): Promise<void> {
  const routeKey = `GET ${location.pathname}${location.search}`

  emit('stator:event-sent', {
    machine: descriptor.machine,
    event: descriptor.event,
    routeKey,
    timestamp: Date.now(),
  })

  const startedAt = performance.now()
  if (el) beginPending(el)
  try {
    const result = await postEvent({ ...descriptor, eventId: newEventId() }, routeKey)
    if (!result.ok) return
    await applyEnvelopeFromResponse(result.res, startedAt, 'post')
  } finally {
    if (el) endPending(el)
  }
}

/**
 * Submit a plain HTML form to its action URL with FormData. Signals
 * `Accept: application/json` so the server returns the directives envelope
 * even though the form looks like a normal browser submission.
 */
async function submitForm(form: HTMLFormElement): Promise<void> {
  const formData = new FormData(form)
  const startedAt = performance.now()
  beginPending(form)
  try {
    let res: Response
    try {
      res = await fetchWithTimeout(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        body: formData,
      })
    } catch (err) {
      console.error('stator: network error during form submit', err)
      emitDispatchError({ phase: err instanceof TimeoutError ? 'timeout' : 'network' }, {})
      return
    }
    if (!res.ok) {
      console.error('stator: form submit failed', res.status, await res.text())
      emitDispatchError({ phase: 'http', status: res.status }, {})
      return
    }
    await applyEnvelopeFromResponse(res, startedAt, 'post')
  } finally {
    endPending(form)
  }
}

async function applyEnvelopeFromResponse(
  res: Response,
  startedAt: number,
  source: 'post' | 'sse',
): Promise<void> {
  let data: WireEnvelope
  try {
    data = await res.json()
  } catch (err) {
    console.error('stator: malformed response', err)
    return
  }
  const durationMs = Math.round(performance.now() - startedAt)
  if (data.patches) {
    emit('stator:patches-received', {
      patches: data.patches,
      source,
      durationMs,
      timestamp: Date.now(),
    })
    applyPatches(data.patches)
  }
  if (data.directives && data.directives.length > 0) {
    applyDirectives(data.directives)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

// Exported for tests only — the runtime self-initializes above, and the
// client bundle (esbuild IIFE) ignores exports. Re-calling init() is safe:
// addEventListener dedupes an identical listener reference.
export { init, initLiveChannel }
