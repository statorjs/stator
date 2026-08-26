/**
 * Stator dev inspector — a framework-owned, dev-only observability toolbar.
 *
 * Auto-injected by `createDevApp` (never in production). Two tabs:
 *
 * - **Wire** subscribes to the public `stator:*` CustomEvent contract the
 *   client runtime dispatches on `window` and renders one row per outgoing
 *   event (↑) and per incoming patch batch (↓), plus a brief flash on each
 *   patched element.
 * - **Machines** fetches `/@stator/inspect` — the dev server's cookie-scoped
 *   state endpoint — and shows every machine's current state, context, and
 *   the events its current state accepts. The endpoint exists only on the
 *   dev server, so on a production page that opted into the toolbar the tab
 *   degrades to a notice.
 *
 * The wire tab depends on nothing but the public event contract — the same
 * surface any external devtool would use. Self-contained: it injects its own
 * styles.
 *
 * The widget is a `<stator-inspector>` custom element with a shadow root
 * (the Astro-dev-toolbar / vite-error-overlay pattern): the inspected app's
 * global element selectors can't restyle the toolbar, and the toolbar's styles
 * provably can't touch the page. Only the element-flash styles live at
 * document level (they decorate app nodes), in the lowest-priority
 * `@layer stator-inspector` so the app always wins over them.
 */

import inspectorCss from './inspector.css'
import flashCss from './inspector-flash.css'

const STORAGE_KEY = 'stator:inspector:open'
const TAB_KEY = 'stator:inspector:tab'
const MAX_ENTRIES = 40
const FLASH_MS = 1200
const REFRESH_DEBOUNCE_MS = 250

const w = window as unknown as { __statorInspectorMounted?: boolean }

/** Structural mirror of the server's InspectPayload — the toolbar depends on
 *  the wire shape, not the server module. */
interface TransitionDesc {
  to?: string
  guarded: boolean
  action: boolean
  emits: string[]
  effect: boolean
}
interface StateDesc {
  on: Record<string, TransitionDesc[]>
  entry: boolean
  after: Array<{ delay: number | 'dynamic'; send: string }>
}
interface MachineDesc {
  name: string
  lifecycle: 'app' | 'session'
  persist: boolean
  initial: string
  states: Record<string, StateDesc>
  on: Record<string, TransitionDesc[]>
  events: string[]
  serverOnly: string[]
  selectors: string[]
  reads: string[]
  context: unknown
  hash?: string
}
interface SnapshotDesc {
  value: string[]
  context: unknown
  code?: string
}
interface InspectPayloadDesc {
  machines: MachineDesc[]
  session: Record<string, SnapshotDesc | null>
  app: Record<string, SnapshotDesc>
  routes: Array<{
    urlPath: string
    methods: Record<string, { kind: string; reads: string[]; live?: boolean }>
  }>
}

function escapeHtml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtTime(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function summarizePatches(patches: Array<{ op: string }>): string {
  const counts: Record<string, number> = {}
  for (const p of patches) counts[p.op] = (counts[p.op] || 0) + 1
  return Object.keys(counts)
    .sort()
    .map((op) => `${op}·${counts[op]}`)
    .join('  ')
}

function formatEventParams(event: Record<string, unknown>): string {
  const { type: _type, ...rest } = event
  const keys = Object.keys(rest)
  if (keys.length === 0) return ''
  return keys.map((k) => `${k}=${JSON.stringify(rest[k])}`).join(' ')
}

/** Events the machine accepts in `leaf`: the state's own handlers plus the
 *  machine-level fallbacks the state doesn't shadow — actor.send's lookup. */
function acceptedEvents(
  m: MachineDesc,
  leaf: string,
): Array<{ type: string; serverOnly: boolean; guarded: boolean }> {
  const stateOn = m.states[leaf]?.on ?? {}
  const merged: Record<string, TransitionDesc[]> = { ...m.on, ...stateOn }
  return Object.keys(merged)
    .sort()
    .map((type) => ({
      type,
      serverOnly: m.serverOnly.includes(type),
      guarded: (merged[type] ?? []).every((t) => t.guarded),
    }))
}

function machineCard(m: MachineDesc, snap: SnapshotDesc | null | undefined): string {
  const leaf = snap ? (snap.value[snap.value.length - 1] ?? m.initial) : m.initial
  const stale = Boolean(snap && m.hash && snap.code !== m.hash)
  const context = snap ? snap.context : m.context
  const chips = acceptedEvents(m, leaf)
    .map(
      (e) =>
        `<span class="stator-inspector-chip${e.serverOnly ? ' stator-inspector-chip--server' : ''}" title="${e.serverOnly ? 'server-only — clients may not dispatch this' : 'dispatchable'}${e.guarded ? '; guarded' : ''}">${escapeHtml(e.type)}${e.guarded ? '<span class="stator-inspector-chip-guard">?</span>' : ''}</span>`,
    )
    .join('')
  return `<div class="stator-inspector-card">
    <div class="stator-inspector-summary stator-inspector-card-head">
      <span class="stator-inspector-machine">${escapeHtml(m.name)}</span>
      <span class="stator-inspector-badge">${m.lifecycle}${m.persist ? ' · persist' : ''}</span>
      <span class="stator-inspector-state">${escapeHtml(leaf)}${snap ? '' : ' <span class="stator-inspector-dim">(initial — not touched this session)</span>'}</span>
      ${stale ? '<span class="stator-inspector-stale" title="the persisted snapshot was written by different machine code — this session resets on its next request">stale</span>' : ''}
    </div>
    <div class="stator-inspector-card-body">
      <div class="stator-inspector-accepts">accepts ${chips || '<span class="stator-inspector-dim">nothing in this state</span>'}</div>
      <pre class="stator-inspector-context${snap ? '' : ' stator-inspector-context--initial'}">${escapeHtml(JSON.stringify(context, null, 2))}</pre>
    </div>
  </div>`
}

function routeRows(payload: InspectPayloadDesc): string {
  return payload.routes
    .map((r) => {
      const methods = Object.entries(r.methods)
        .map(([method, m]) => {
          const reads = m.reads.length
            ? m.reads
                .map((n) => `<span class="stator-inspector-chip">${escapeHtml(n)}</span>`)
                .join('')
            : '<span class="stator-inspector-dim">no reads</span>'
          return `<span class="stator-inspector-route-method">${escapeHtml(method)}·${escapeHtml(m.kind)}${m.live ? '·live' : ''}</span> ${reads}`
        })
        .join('<br>')
      return `<div class="stator-inspector-route"><span class="stator-inspector-route-path">${escapeHtml(r.urlPath)}</span><span>${methods}</span></div>`
    })
    .join('')
}

function mount(): void {
  // Flash styles decorate APP elements, so they can't live in the widget's
  // shadow — they're document-level, in `@layer stator-inspector` (see
  // inspector-flash.css) so the app's own (unlayered) styles always win.
  const flashSheet = new CSSStyleSheet()
  flashSheet.replaceSync(flashCss)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, flashSheet]

  // The widget itself: a custom element whose shadow root carries the markup
  // and styles — isolated from the page's cascade in both directions.
  if (!customElements.get('stator-inspector')) {
    customElements.define('stator-inspector', class extends HTMLElement {})
  }
  const root = document.createElement('stator-inspector')
  const shadow = root.attachShadow({ mode: 'open' })
  const widgetSheet = new CSSStyleSheet()
  widgetSheet.replaceSync(inspectorCss)
  shadow.adoptedStyleSheets = [widgetSheet]
  shadow.innerHTML = `
    <button class="stator-inspector-toggle" type="button" aria-label="Show stator inspector">
      <span aria-hidden="true">{ }</span> Inspect
    </button>
    <section class="stator-inspector-drawer" aria-label="Stator inspector" hidden>
      <header class="stator-inspector-header">
        <span class="stator-inspector-title"><span class="stator-inspector-dot" aria-hidden="true"></span> Stator inspector</span>
        <nav class="stator-inspector-tabs" aria-label="Inspector tabs">
          <button class="stator-inspector-tab" type="button" data-tab="wire">Wire</button>
          <button class="stator-inspector-tab" type="button" data-tab="machines">Machines</button>
        </nav>
        <span class="stator-inspector-legend">
          <span class="stator-inspector-key stator-inspector-key--up">↑ event</span>
          <span class="stator-inspector-key stator-inspector-key--down">↓ patches</span>
        </span>
        <button class="stator-inspector-clear" type="button" title="Clear log">clear</button>
        <button class="stator-inspector-refresh" type="button" title="Refresh machine state" hidden>refresh</button>
        <button class="stator-inspector-close" type="button" aria-label="Close inspector">×</button>
      </header>
      <div class="stator-inspector-body">
        <p class="stator-inspector-empty">Interact with the page to see events and patches.</p>
      </div>
      <div class="stator-inspector-machines" hidden>
        <p class="stator-inspector-empty">Loading machine state…</p>
      </div>
    </section>`
  document.body.appendChild(root)

  const q = (sel: string) => shadow.querySelector(sel) as HTMLElement
  const drawer = q('.stator-inspector-drawer')
  const body = q('.stator-inspector-body')
  const machinesEl = q('.stator-inspector-machines')
  const toggle = q('.stator-inspector-toggle')
  const legend = q('.stator-inspector-legend')
  const clearBtn = q('.stator-inspector-clear')
  const refreshBtn = q('.stator-inspector-refresh')

  // ── Machines tab: fetch + render ─────────────────────────────────────────
  let refreshTimer: number | undefined
  const renderMachines = (payload: InspectPayloadDesc): void => {
    const cards = payload.machines
      .map((m) =>
        machineCard(m, m.lifecycle === 'session' ? payload.session[m.name] : payload.app[m.name]),
      )
      .join('')
    machinesEl.innerHTML = `${cards || '<p class="stator-inspector-empty">No machines discovered.</p>'}
      <div class="stator-inspector-routes-head">routes</div>
      ${routeRows(payload)}`
    // Context toggles: clicking a card head collapses/expands its body.
    for (const head of Array.from(machinesEl.querySelectorAll('.stator-inspector-card-head'))) {
      head.addEventListener('click', () => {
        const cardBody = head.nextElementSibling as HTMLElement | null
        if (cardBody) cardBody.hidden = !cardBody.hidden
      })
    }
  }
  const refreshMachines = (): void => {
    fetch('/@stator/inspect', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((payload: InspectPayloadDesc) => renderMachines(payload))
      .catch(() => {
        machinesEl.innerHTML =
          '<p class="stator-inspector-empty">State inspection is served by the dev server only — this page has the wire toolbar without it.</p>'
      })
  }
  const scheduleRefresh = (): void => {
    if (drawer.hidden || machinesEl.hidden) return
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(refreshMachines, REFRESH_DEBOUNCE_MS)
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const tabs = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.stator-inspector-tab'))
  const setTab = (tab: string) => {
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {}
    const machines = tab === 'machines'
    body.hidden = machines
    machinesEl.hidden = !machines
    legend.hidden = machines
    clearBtn.hidden = machines
    refreshBtn.hidden = !machines
    for (const t of tabs) t.classList.toggle('stator-inspector-tab--active', t.dataset.tab === tab)
    if (machines) refreshMachines()
  }
  for (const t of tabs) t.addEventListener('click', () => setTab(t.dataset.tab ?? 'wire'))

  const setOpen = (open: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? 'true' : 'false')
    } catch {}
    ;(drawer as HTMLElement).hidden = !open
    ;(toggle as HTMLElement).hidden = open
    if (open && !machinesEl.hidden) refreshMachines()
  }
  let initiallyOpen = true
  try {
    initiallyOpen = localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {}
  let initialTab = 'wire'
  try {
    initialTab = localStorage.getItem(TAB_KEY) === 'machines' ? 'machines' : 'wire'
  } catch {}
  setTab(initialTab)
  setOpen(initiallyOpen)

  toggle.addEventListener('click', () => setOpen(true))
  q('.stator-inspector-close').addEventListener('click', () => setOpen(false))
  refreshBtn.addEventListener('click', refreshMachines)
  clearBtn.addEventListener('click', () => {
    body.innerHTML = '<p class="stator-inspector-empty">Log cleared.</p>'
  })

  const addEntry = (kind: 'up' | 'down', html: string, detail: unknown) => {
    const empty = body.querySelector('.stator-inspector-empty')
    if (empty) empty.remove()
    const row = document.createElement('div')
    row.className = `stator-inspector-row stator-inspector-row--${kind}`
    row.innerHTML = html
    const expand = document.createElement('pre')
    expand.className = 'stator-inspector-detail'
    expand.hidden = true
    expand.textContent = JSON.stringify(detail, null, 2)
    row.appendChild(expand)
    ;(row.querySelector('.stator-inspector-summary') as HTMLElement).addEventListener(
      'click',
      () => {
        expand.hidden = !expand.hidden
      },
    )
    body.insertBefore(row, body.firstChild)
    while (body.children.length > MAX_ENTRIES) body.removeChild(body.lastChild as Node)
  }

  window.addEventListener('stator:event-sent', (e: Event) => {
    const { machine, event, timestamp } = (e as CustomEvent).detail
    addEntry(
      'up',
      `<div class="stator-inspector-summary">
        <span class="stator-inspector-time">${fmtTime(timestamp)}</span>
        <span class="stator-inspector-arrow">↑</span>
        <span class="stator-inspector-machine">${escapeHtml(machine)}</span>
        <span class="stator-inspector-event-type">${escapeHtml(event.type)}</span>
        <span class="stator-inspector-params">${escapeHtml(formatEventParams(event))}</span>
      </div>`,
      (e as CustomEvent).detail,
    )
  })

  window.addEventListener('stator:dispatch-error', (e: Event) => {
    const { machine, phase, status, timestamp } = (e as CustomEvent).detail
    addEntry(
      'up',
      `<div class="stator-inspector-summary">
        <span class="stator-inspector-time">${fmtTime(timestamp)}</span>
        <span class="stator-inspector-arrow">✕</span>
        <span class="stator-inspector-machine">${escapeHtml(machine ?? 'form')}</span>
        <span class="stator-inspector-event-type">${escapeHtml(phase)}</span>
        <span class="stator-inspector-params">${status != null ? escapeHtml(String(status)) : ''}</span>
      </div>`,
      (e as CustomEvent).detail,
    )
  })

  window.addEventListener('stator:patches-received', (e: Event) => {
    const { patches, source, durationMs, timestamp } = (e as CustomEvent).detail
    const timing = durationMs != null ? `${durationMs}ms` : ''
    const sourceLabel = source === 'sse' ? '(sse push)' : '(post)'
    addEntry(
      'down',
      `<div class="stator-inspector-summary">
        <span class="stator-inspector-time">${fmtTime(timestamp)}</span>
        <span class="stator-inspector-arrow">↓</span>
        <span class="stator-inspector-machine">${patches.length} patch${patches.length === 1 ? '' : 'es'}</span>
        <span class="stator-inspector-event-type">${escapeHtml(summarizePatches(patches))}</span>
        <span class="stator-inspector-params">${sourceLabel} ${timing}</span>
      </div>`,
      (e as CustomEvent).detail,
    )
    // Patches mean state moved — keep the Machines tab current while visible.
    scheduleRefresh()
  })

  window.addEventListener('stator:patch-applied', (e: Event) => {
    const { patch, element } = (e as CustomEvent).detail
    if (!element) return
    // Only flash while the drawer is open — the flash is an inspection aid, not
    // ambient page decoration; a closed inspector shouldn't touch the app.
    if (drawer.hidden) return
    const opClass = `stator-flash--${patch.op}`
    ;(element as HTMLElement).classList.add('stator-flash', opClass)
    window.setTimeout(() => {
      ;(element as HTMLElement).classList.remove('stator-flash', opClass)
    }, FLASH_MS)
  })
}

if (!w.__statorInspectorMounted) {
  w.__statorInspectorMounted = true
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
}
