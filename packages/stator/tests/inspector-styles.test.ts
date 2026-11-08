import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const widgetCss = readFileSync(resolve(here, '../src/client/inspector.css'), 'utf8')
const flashCss = readFileSync(resolve(here, '../src/client/inspector-flash.css'), 'utf8')
const inspectorTs = readFileSync(resolve(here, '../src/client/inspector.ts'), 'utf8')

describe('inspector style isolation', () => {
  it('the widget is a shadow-rooted custom element — app selectors cannot restyle it', () => {
    // The shipped counter-case: todomvc's global `button` reset (unlayered, so
    // it beat every layered rule) stripped the toolbar's background/border/font.
    assert.match(inspectorTs, /customElements\.define\('stator-inspector'/)
    assert.match(inspectorTs, /attachShadow\(\{ mode: 'open' \}\)/)
    assert.match(inspectorTs, /shadow\.adoptedStyleSheets/)
  })

  it('widget styles target the shadow tree (:host), not the document', () => {
    assert.match(widgetCss, /:host\s*\{/)
    assert.doesNotMatch(widgetCss, /@layer\s+[\w-]*\s*\{/)
  })

  it('flash styles stay document-level in the stator-inspector layer, so an unlayered app always wins', () => {
    // The flash decorates APP elements — it must remain the lowest-priority
    // author layer, and inspector.ts must adopt it on the document.
    assert.match(flashCss, /@layer\s+stator-inspector\s*\{/)
    assert.match(inspectorTs, /document\.adoptedStyleSheets/)
  })

  it('never touches background in the element flash — a background flash masks the very change it highlights (finding #7)', () => {
    // From the flash rule onward: `.stator-flash`, its keyframes, and the
    // op-colour variants. None may set/animate background — animations outrank
    // all normal author styles (layer or not), so a background flash would sit
    // on top of the patched element's own background for the flash's duration.
    const flashRegion = flashCss.slice(flashCss.indexOf('.stator-flash {'))
    assert.doesNotMatch(flashRegion, /background/i)
  })
})
