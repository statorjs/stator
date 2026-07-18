/**
 * Stator dev inspector — a framework-owned, dev-only observability toolbar.
 *
 * Auto-injected by `createDevApp` (never in production). It subscribes to the
 * public `stator:*` CustomEvent contract the client runtime dispatches on
 * `window` and renders a bottom drawer with one row per outgoing event (↑) and
 * per incoming patch batch (↓), plus a brief flash on each patched element.
 *
 * It depends on nothing but that event contract — the same surface any external
 * devtool would use. Self-contained: it injects its own styles.
 */

import inspectorCss from './inspector.css'

const STORAGE_KEY = 'stator:inspector:open'
const MAX_ENTRIES = 40
const FLASH_MS = 1200

const w = window as unknown as { __statorInspectorMounted?: boolean }

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

function mount(): void {
  // Inject as a constructable stylesheet in `@layer stator-inspector` (see
  // inspector.css) — the lowest-priority author layer, so the inspected app's
  // own (unlayered) styles always win over the inspector.
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(inspectorCss)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]

  const root = document.createElement('div')
  root.className = 'stator-inspector'
  root.innerHTML = `
    <button class="stator-inspector-toggle" type="button" aria-label="Show stator inspector">
      <span aria-hidden="true">{ }</span> Inspect
    </button>
    <section class="stator-inspector-drawer" aria-label="Stator inspector" hidden>
      <header class="stator-inspector-header">
        <span class="stator-inspector-title"><span class="stator-inspector-dot" aria-hidden="true"></span> Stator inspector</span>
        <span class="stator-inspector-legend">
          <span class="stator-inspector-key stator-inspector-key--up">↑ event</span>
          <span class="stator-inspector-key stator-inspector-key--down">↓ patches</span>
        </span>
        <button class="stator-inspector-clear" type="button" title="Clear log">clear</button>
        <button class="stator-inspector-close" type="button" aria-label="Close inspector">×</button>
      </header>
      <div class="stator-inspector-body">
        <p class="stator-inspector-empty">Interact with the page to see events and patches.</p>
      </div>
    </section>`
  document.body.appendChild(root)

  const q = (sel: string) => root.querySelector(sel) as HTMLElement
  const drawer = q('.stator-inspector-drawer')
  const body = q('.stator-inspector-body')
  const toggle = q('.stator-inspector-toggle')

  const setOpen = (open: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? 'true' : 'false')
    } catch {}
    ;(drawer as HTMLElement).hidden = !open
    ;(toggle as HTMLElement).hidden = open
  }
  let initiallyOpen = true
  try {
    initiallyOpen = localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {}
  setOpen(initiallyOpen)

  toggle.addEventListener('click', () => setOpen(true))
  q('.stator-inspector-close').addEventListener('click', () => setOpen(false))
  q('.stator-inspector-clear').addEventListener('click', () => {
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
  })

  window.addEventListener('stator:patch-applied', (e: Event) => {
    const { patch, element } = (e as CustomEvent).detail
    if (!element) return
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
