import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scopeCss } from '../src/compiler/styles.ts'

const H = 'abcd1234'
const A = `[data-s-${H}]`

describe('compiler: scopeCss (attribute scoping)', () => {
  it('appends the scope attribute to a simple selector subject', () => {
    assert.equal(
      scopeCss('.btn { color: red }', H).replace(/\s+/g, ' ').trim(),
      `.btn${A} { color: red }`,
    )
  })

  it('scopes only the subject of a descendant selector', () => {
    assert.ok(scopeCss('.card .btn { color: red }', H).includes(`.card .btn${A}`))
  })

  it('inserts the attribute before a pseudo-element', () => {
    assert.ok(scopeCss('.btn::before { content: "" }', H).includes(`.btn${A}::before`))
  })

  it('scopes each selector in a list', () => {
    const out = scopeCss('.a, .b { color: red }', H)
    assert.ok(out.includes(`.a${A}`))
    assert.ok(out.includes(`.b${A}`))
  })

  it('unwraps :global() and leaves a global subject unscoped', () => {
    const out = scopeCss(':global(.lib) { color: red }', H)
    assert.ok(out.includes('.lib'))
    assert.ok(!out.includes(A))
  })

  it('keeps a :global ancestor global but scopes the local subject', () => {
    const out = scopeCss(':global(.dark) .btn { color: red }', H)
    assert.ok(out.includes(`.dark .btn${A}`))
  })

  it('renames @keyframes and rewrites animation references', () => {
    const css = `@keyframes spin { from { opacity: 0 } to { opacity: 1 } }
.x { animation: spin 1s linear }
.y { animation-name: spin }`
    const out = scopeCss(css, H)
    assert.ok(out.includes(`@keyframes spin-${H}`))
    assert.ok(out.includes(`animation: spin-${H} 1s linear`))
    assert.ok(out.includes(`animation-name: spin-${H}`))
    // keyframe step selectors (from/to) are not attribute-scoped
    assert.ok(!out.includes(`from${A}`))
  })

  it('scopes selectors inside @media', () => {
    const out = scopeCss('@media (min-width: 600px) { .btn { color: red } }', H)
    assert.ok(out.includes(`.btn${A}`))
  })

  it('puts the scope attribute INSIDE :where(), preserving its zero specificity', () => {
    const out = scopeCss(':where(img) { display: block }', H)
    assert.ok(out.includes(`:where(img${A})`))
    assert.ok(!out.includes(`:where(img)${A}`))
  })

  it('handles multiple :where() arguments, attribute on each', () => {
    const out = scopeCss(':where(img, picture) { display: block }', H)
    assert.ok(out.includes(`:where(img${A}, picture${A})`))
  })

  it('still scopes a non-subject ancestor normally when the subject is :where()', () => {
    const out = scopeCss('.card :where(img) { display: block }', H)
    assert.ok(out.includes(`.card :where(img${A})`))
    assert.ok(!out.includes(`.card${A}`))
  })
})

describe('client-component descendant scoping', () => {
  it('scopes selectors as descendants of the root; root tag gets the attr itself', () => {
    const css = `
      variant-picker { display: block; }
      .swatch { width: 32px; }
      .swatch.is-on:hover { outline: none; }
      :global(body) .row { gap: 4px; }
    `
    const out = scopeCss(css, 'h1', { strategy: 'descendant', rootTag: 'variant-picker' })
    assert.ok(out.includes('variant-picker[data-s-h1]'))
    assert.ok(out.includes('[data-s-h1] .swatch'))
    assert.ok(out.includes('[data-s-h1] .swatch.is-on:hover'))
    // :global escapes scoping entirely
    assert.ok(out.includes('body .row'))
    assert.ok(!out.includes('[data-s-h1] body'))
  })
})
