import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const widgetCss = readFileSync(resolve(here, '../src/client/inspector.css'), 'utf8')
const flashCss = readFileSync(resolve(here, '../src/client/inspector-flash.css'), 'utf8')
const inspectorTs = readFileSync(resolve(here, '../src/client/inspector.ts'), 'utf8')

describe('inspector style isolation', () => {
  it('the widget is a shadow-rooted custom element — app selectors cannot restyle it', () => {
    // The shipped counter-case: todomvc's global `button` reset (unlayered, so
    // it beat every layered rule) stripped the toolbar's background/border/font.
    expect(inspectorTs).toMatch(/customElements\.define\('stator-inspector'/)
    expect(inspectorTs).toMatch(/attachShadow\(\{ mode: 'open' \}\)/)
    expect(inspectorTs).toMatch(/shadow\.adoptedStyleSheets/)
  })

  it('widget styles target the shadow tree (:host), not the document', () => {
    expect(widgetCss).toMatch(/:host\s*\{/)
    expect(widgetCss).not.toMatch(/@layer\s+[\w-]*\s*\{/)
  })

  it('flash styles stay document-level in the stator-inspector layer, so an unlayered app always wins', () => {
    // The flash decorates APP elements — it must remain the lowest-priority
    // author layer, and inspector.ts must adopt it on the document.
    expect(flashCss).toMatch(/@layer\s+stator-inspector\s*\{/)
    expect(inspectorTs).toMatch(/document\.adoptedStyleSheets/)
  })

  it('never touches background in the element flash — a background flash masks the very change it highlights (finding #7)', () => {
    // From the flash rule onward: `.stator-flash`, its keyframes, and the
    // op-colour variants. None may set/animate background — animations outrank
    // all normal author styles (layer or not), so a background flash would sit
    // on top of the patched element's own background for the flash's duration.
    const flashRegion = flashCss.slice(flashCss.indexOf('.stator-flash {'))
    expect(flashRegion).not.toMatch(/background/i)
  })
})
