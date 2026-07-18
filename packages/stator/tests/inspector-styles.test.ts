import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/inspector.css'),
  'utf8',
)

describe('inspector.css', () => {
  it('is scoped to the stator-inspector cascade layer, so an unlayered app always wins', () => {
    expect(css).toMatch(/@layer\s+stator-inspector\s*\{/)
  })

  it('never touches background in the element flash — a background flash masks the very change it highlights (finding #7)', () => {
    // From the flash rule onward: `.stator-flash`, its keyframes, and the
    // op-colour variants. None may set/animate background — animations outrank
    // all normal author styles (layer or not), so a background flash would sit
    // on top of the patched element's own background for the flash's duration.
    const flashRegion = css.slice(css.indexOf('.stator-flash {'))
    expect(flashRegion).not.toMatch(/background/i)
  })
})
