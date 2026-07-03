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

const EVENT_TYPES = ['click', 'submit', 'change', 'input'] as const

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

function initLiveChannel(): void {
  const meta = document.querySelector('meta[name="stator-live"][content="true"]')
  if (!meta) return

  const routeKey = `GET ${location.pathname}`
  const url = `/__sse?route=${encodeURIComponent(routeKey)}`
  const sse = new EventSource(url, { withCredentials: true })

  let everOpened = false
  sse.addEventListener('open', () => {
    if (everOpened) {
      // Reconnect — reload rather than risk stale state.
      location.reload()
      return
    }
    everOpened = true
  })

  sse.addEventListener('message', (e) => {
    let data: WireEnvelope
    try {
      data = JSON.parse(e.data)
    } catch (err) {
      console.error('stator: malformed SSE message', err)
      return
    }
    if (data.patches) {
      emit('stator:patches-received', {
        patches: data.patches,
        source: 'sse',
        timestamp: Date.now(),
      })
      applyPatches(data.patches)
    }
    if (data.directives && data.directives.length > 0) {
      applyDirectives(data.directives)
    }
  })

  sse.addEventListener('error', () => {
    if (sse.readyState === EventSource.CLOSED) {
      console.warn('stator: SSE permanently closed')
    }
  })
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
        void dispatchEvent(descriptor)
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

  void dispatchEvent(descriptor)
}

async function dispatchEvent(descriptor: {
  machine: string
  event: { type: string }
}): Promise<void> {
  const routeKey = `GET ${location.pathname}`

  emit('stator:event-sent', {
    machine: descriptor.machine,
    event: descriptor.event,
    routeKey,
    timestamp: Date.now(),
  })

  const startedAt = performance.now()
  let res: Response
  try {
    res = await fetch('/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Stator-Route': routeKey,
      },
      credentials: 'same-origin',
      body: JSON.stringify(descriptor),
    })
  } catch (err) {
    console.error('stator: network error during dispatch', err)
    return
  }
  if (!res.ok) {
    console.error('stator: event POST failed', res.status, await res.text())
    return
  }
  await applyEnvelopeFromResponse(res, startedAt, 'post')
}

/**
 * Submit a plain HTML form to its action URL with FormData. Signals
 * `Accept: application/json` so the server returns the directives envelope
 * even though the form looks like a normal browser submission.
 */
async function submitForm(form: HTMLFormElement): Promise<void> {
  const formData = new FormData(form)
  const startedAt = performance.now()
  let res: Response
  try {
    res = await fetch(form.action, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      body: formData,
    })
  } catch (err) {
    console.error('stator: network error during form submit', err)
    return
  }
  if (!res.ok) {
    console.error('stator: form submit failed', res.status, await res.text())
    return
  }
  await applyEnvelopeFromResponse(res, startedAt, 'post')
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
