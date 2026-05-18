/**
 * stator client runtime.
 *
 * Responsibilities:
 *   1. Attach delegated event listeners on document.body for a fixed set of
 *      DOM event types. On fire, look for the nearest ancestor carrying
 *      `data-event-<type>="..."` and POST the JSON descriptor to /__events.
 *   2. Apply patches in the response according to the wire protocol — see
 *      WIRE.md. Two target kinds (slot, element) × three ops (text, html,
 *      attr) currently implemented.
 *   3. Dispatch `stator:*` CustomEvents on `window` at protocol edges so
 *      inspectors and devtools can observe the traffic without monkey-
 *      patching. See "Observability hooks" below for the contract.
 */

type SlotTarget = { kind: 'slot'; id: string }
type ElementTarget = { kind: 'element'; id: string }

type Patch =
  | { target: SlotTarget; op: 'text'; value: string }
  | { target: SlotTarget; op: 'html'; value: string }
  | { target: ElementTarget; op: 'attr'; name: string; value: string }

const EVENT_TYPES = ['click', 'submit', 'change', 'input'] as const

/* ------------------------------------------------------------------ */
/* Observability hooks                                                 */
/* ------------------------------------------------------------------ */
/*
 * Three CustomEvents dispatched on `window`:
 *
 *   stator:event-sent       — just before a user-triggered event POSTs.
 *     detail: { machine, event, routeKey, timestamp }
 *
 *   stator:patches-received — after a patch batch is parsed, before apply.
 *     detail: { patches, source: 'post' | 'sse', durationMs?, timestamp }
 *
 *   stator:patch-applied    — once per patch, just after applying it.
 *     detail: { patch, element, timestamp }
 *
 * `element` may be null if the patch's target id didn't resolve. `durationMs`
 * is present on `source: 'post'` events (round-trip time) and absent for SSE
 * pushes (the framework doesn't time those).
 *
 * Stable contract — observable surface; safe to consume from inspector or
 * third-party tooling.
 */

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

/**
 * When the server marks a page as live (via <meta name="stator-live">), open
 * an SSE channel that receives patches whenever any machine the route reads
 * changes — including from other sessions' POSTs.
 *
 * Reconnection: EventSource auto-reconnects with exponential backoff. On
 * reconnect, the server has lost this connection's old slot map and can't
 * diff against what the client currently has. POC strategy: full reload.
 * V1 work would replace this with a diff against client-known state.
 */
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
    let data: { patches?: Patch[] }
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
  })

  sse.addEventListener('error', () => {
    // Browser will auto-reconnect. Nothing to do here; the 'open' handler
    // detects the reconnect when it fires again.
  })
}

function handleEvent(e: Event): void {
  const target = e.target as Element | null
  if (!target) return
  const attrName = `data-event-${e.type}`
  const el = target.closest(`[${attrName}]`)
  if (!el) return
  const raw = el.getAttribute(attrName)
  if (!raw) return

  let descriptor: { machine: string; event: { type: string } }
  try {
    descriptor = JSON.parse(raw)
  } catch (err) {
    console.error('stator: malformed event descriptor on', el, raw)
    return
  }

  if (e.type === 'submit') e.preventDefault()
  void dispatch(descriptor)
}

async function dispatch(descriptor: {
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
  let data: { patches: Patch[] }
  try {
    data = await res.json()
  } catch (err) {
    console.error('stator: malformed event response', err)
    return
  }
  const durationMs = Math.round(performance.now() - startedAt)
  emit('stator:patches-received', {
    patches: data.patches,
    source: 'post',
    durationMs,
    timestamp: Date.now(),
  })
  applyPatches(data.patches)
}

function applyPatches(patches: Patch[]): void {
  for (const patch of patches) {
    let element: Element | null = null
    if (patch.target.kind === 'slot') {
      element = document.querySelector(`[data-slot="${patch.target.id}"]`)
      if (element) {
        if (patch.op === 'text') element.textContent = patch.value
        else if (patch.op === 'html') element.innerHTML = patch.value
      }
    } else if (patch.target.kind === 'element') {
      element = document.querySelector(`[data-stator-id="${patch.target.id}"]`)
      if (element && patch.op === 'attr') element.setAttribute(patch.name, patch.value)
    }
    emit('stator:patch-applied', { patch, element, timestamp: Date.now() })
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
