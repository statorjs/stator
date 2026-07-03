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

const STYLES = `
.stator-inspector { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483000; pointer-events: none; }
.stator-inspector > * { pointer-events: auto; }
.stator-inspector-drawer[hidden], .stator-inspector-toggle[hidden] { display: none; }
.stator-inspector-toggle {
  position: fixed; bottom: 1rem; right: 1rem; background: #1a1a1a; color: #d0d0d0;
  border: 1px solid #2a2a2a; padding: 0.45rem 0.85rem; border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem;
  cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.18); display: inline-flex;
  align-items: center; gap: 0.4rem;
}
.stator-inspector-toggle:hover { background: #232323; color: #f0f0f0; }
.stator-inspector-drawer {
  background: #141414; color: #d0d0d0; border-top: 1px solid #2a2a2a; max-height: 240px;
  display: flex; flex-direction: column; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem; box-shadow: 0 -2px 12px rgba(0,0,0,0.25);
}
.stator-inspector-header {
  display: flex; align-items: center; gap: 1rem; padding: 0.5rem 0.9rem;
  background: #1a1a1a; border-bottom: 1px solid #262626; flex-shrink: 0;
}
.stator-inspector-title { display: inline-flex; align-items: center; gap: 0.5rem; color: #f5f5f5; font-weight: 600; letter-spacing: 0.02em; }
.stator-inspector-dot { width: 8px; height: 8px; border-radius: 50%; background: #6a9955; box-shadow: 0 0 0 2px rgba(106,153,85,0.18); }
.stator-inspector-legend { display: inline-flex; gap: 0.75rem; color: #888; }
.stator-inspector-key--up { color: #dcdcaa; }
.stator-inspector-key--down { color: #9cdcfe; }
.stator-inspector-header button {
  background: transparent; border: 1px solid #333; color: #aaa; padding: 0.15rem 0.55rem;
  font-family: inherit; font-size: 0.75rem; border-radius: 4px; cursor: pointer;
}
.stator-inspector-header button:hover { background: #232323; color: #f0f0f0; }
.stator-inspector-close { margin-left: auto; font-size: 1rem !important; line-height: 1; padding: 0.05rem 0.5rem !important; }
.stator-inspector-body { flex: 1; overflow-y: auto; padding: 0; }
.stator-inspector-empty { margin: 0; padding: 1rem 0.9rem; color: #6a6a6a; font-style: italic; }
.stator-inspector-row { border-bottom: 1px solid #1f1f1f; }
.stator-inspector-row:last-child { border-bottom: none; }
.stator-inspector-summary {
  display: grid; grid-template-columns: 90px 16px 130px 1fr auto; align-items: baseline;
  gap: 0.75rem; padding: 0.35rem 0.9rem; cursor: pointer; user-select: none;
}
.stator-inspector-summary:hover { background: #1c1c1c; }
.stator-inspector-time { color: #6a6a6a; font-variant-numeric: tabular-nums; }
.stator-inspector-arrow { text-align: center; font-weight: 700; }
.stator-inspector-row--up .stator-inspector-arrow { color: #dcdcaa; }
.stator-inspector-row--down .stator-inspector-arrow { color: #9cdcfe; }
.stator-inspector-machine { color: #c586c0; font-weight: 500; }
.stator-inspector-row--down .stator-inspector-machine { color: #9cdcfe; }
.stator-inspector-event-type { color: #4ec9b0; font-weight: 500; }
.stator-inspector-params { color: #888; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.stator-inspector-detail {
  margin: 0; padding: 0.5rem 0.9rem 0.75rem 2.5rem; background: #0e0e0e; color: #cfcfcf;
  font-size: 0.74rem; white-space: pre-wrap; word-break: break-word; border-top: 1px dashed #2a2a2a;
}
.stator-flash { outline-style: solid; outline-offset: 3px; animation: stator-flash 1200ms ease-out forwards; border-radius: 2px; }
@keyframes stator-flash {
  0% { outline-width: 3px; outline-color: var(--flash-color, dodgerblue); background-color: var(--flash-bg, rgba(30,144,255,0.16)); }
  30% { outline-width: 3px; outline-color: var(--flash-color, dodgerblue); background-color: var(--flash-bg, rgba(30,144,255,0.16)); }
  100% { outline-width: 0; outline-color: transparent; background-color: transparent; }
}
.stator-flash--text { --flash-color: #3b82f6; --flash-bg: rgba(59,130,246,0.12); }
.stator-flash--attr { --flash-color: #a855f7; --flash-bg: rgba(168,85,247,0.12); }
.stator-flash--html { --flash-color: #14b8a6; --flash-bg: rgba(20,184,166,0.10); }
@media (max-height: 600px) { .stator-inspector-drawer { max-height: 50vh; } }
`

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
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)

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
