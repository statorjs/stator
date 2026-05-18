/**
 * stator inspector — demo-only observability UI.
 *
 * Subscribes to the framework's `stator:*` CustomEvents on `window` and:
 *   - Renders a bottom-fixed drawer with one row per outgoing event (↑)
 *     and per incoming patch batch (↓). Click a row to expand its JSON.
 *   - Adds a `.stator-flash` class to each patched DOM element for a brief
 *     visual confirmation that "this is the slot/element the patch hit."
 *
 * Plain vanilla JS — this is example-app code, not framework code. The
 * framework's only contribution is dispatching the events; anything wanting
 * to observe them (this, future devtools, telemetry) sits on top.
 */
;(() => {
  if (window.__statorInspectorMounted) return
  window.__statorInspectorMounted = true

  const STORAGE_KEY = 'stator:inspector:open'
  const MAX_ENTRIES = 40
  const FLASH_MS = 1200

  const isInitiallyOpen = () => localStorage.getItem(STORAGE_KEY) !== 'false'

  function mount() {
    const root = document.createElement('div')
    root.className = 'stator-inspector'
    root.innerHTML = `
      <button class="stator-inspector-toggle" type="button" aria-label="Show stator inspector">
        <span aria-hidden="true">{ }</span> Inspect
      </button>
      <section class="stator-inspector-drawer" aria-label="Stator inspector" hidden>
        <header class="stator-inspector-header">
          <span class="stator-inspector-title">
            <span class="stator-inspector-dot" aria-hidden="true"></span>
            Stator inspector
          </span>
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
      </section>
    `
    document.body.appendChild(root)

    const drawer = root.querySelector('.stator-inspector-drawer')
    const body = root.querySelector('.stator-inspector-body')
    const toggle = root.querySelector('.stator-inspector-toggle')
    const closeBtn = root.querySelector('.stator-inspector-close')
    const clearBtn = root.querySelector('.stator-inspector-clear')

    function setOpen(open) {
      localStorage.setItem(STORAGE_KEY, open ? 'true' : 'false')
      drawer.hidden = !open
      toggle.hidden = open
    }
    setOpen(isInitiallyOpen())

    toggle.addEventListener('click', () => setOpen(true))
    closeBtn.addEventListener('click', () => setOpen(false))
    clearBtn.addEventListener('click', () => {
      body.innerHTML = '<p class="stator-inspector-empty">Log cleared.</p>'
    })

    function fmtTime(t) {
      const d = new Date(t)
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const ss = String(d.getSeconds()).padStart(2, '0')
      const ms = String(d.getMilliseconds()).padStart(3, '0')
      return `${hh}:${mm}:${ss}.${ms}`
    }

    function summarizePatches(patches) {
      const counts = {}
      for (const p of patches) counts[p.op] = (counts[p.op] || 0) + 1
      return Object.keys(counts)
        .sort()
        .map((op) => `${op}·${counts[op]}`)
        .join('  ')
    }

    function formatEventParams(event) {
      const { type, ...rest } = event
      const keys = Object.keys(rest)
      if (keys.length === 0) return ''
      return keys.map((k) => `${k}=${JSON.stringify(rest[k])}`).join(' ')
    }

    function addEntry(kind, html, detail) {
      // Drop the placeholder if it's still there.
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
      row.querySelector('.stator-inspector-summary').addEventListener('click', () => {
        expand.hidden = !expand.hidden
      })

      body.insertBefore(row, body.firstChild)
      while (body.children.length > MAX_ENTRIES) {
        body.removeChild(body.lastChild)
      }
    }

    window.addEventListener('stator:event-sent', (e) => {
      const { machine, event, timestamp } = e.detail
      addEntry(
        'up',
        `<div class="stator-inspector-summary">
          <span class="stator-inspector-time">${fmtTime(timestamp)}</span>
          <span class="stator-inspector-arrow">↑</span>
          <span class="stator-inspector-machine">${machine}</span>
          <span class="stator-inspector-event-type">${escapeHtml(event.type)}</span>
          <span class="stator-inspector-params">${escapeHtml(formatEventParams(event))}</span>
        </div>`,
        e.detail,
      )
    })

    window.addEventListener('stator:patches-received', (e) => {
      const { patches, source, durationMs, timestamp } = e.detail
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
        e.detail,
      )
    })

    window.addEventListener('stator:patch-applied', (e) => {
      const { patch, element } = e.detail
      if (!element) return
      const opClass = `stator-flash--${patch.op}`
      element.classList.add('stator-flash', opClass)
      window.setTimeout(() => {
        element.classList.remove('stator-flash', opClass)
      }, FLASH_MS)
    })
  }

  function escapeHtml(s) {
    if (s == null) return ''
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
})()
