import { describe, expect, it } from 'vitest'
import { scopeCss } from '../src/compiler/styles.ts'

const H = 'abcd1234'
const A = `[data-s-${H}]`

describe('compiler: scopeCss (attribute scoping)', () => {
  it('appends the scope attribute to a simple selector subject', () => {
    expect(scopeCss('.btn { color: red }', H).replace(/\s+/g, ' ').trim()).toBe(
      `.btn${A} { color: red }`,
    )
  })

  it('scopes only the subject of a descendant selector', () => {
    expect(scopeCss('.card .btn { color: red }', H)).toContain(`.card .btn${A}`)
  })

  it('inserts the attribute before a pseudo-element', () => {
    expect(scopeCss('.btn::before { content: "" }', H)).toContain(`.btn${A}::before`)
  })

  it('scopes each selector in a list', () => {
    const out = scopeCss('.a, .b { color: red }', H)
    expect(out).toContain(`.a${A}`)
    expect(out).toContain(`.b${A}`)
  })

  it('unwraps :global() and leaves a global subject unscoped', () => {
    const out = scopeCss(':global(.lib) { color: red }', H)
    expect(out).toContain('.lib')
    expect(out).not.toContain(A)
  })

  it('keeps a :global ancestor global but scopes the local subject', () => {
    const out = scopeCss(':global(.dark) .btn { color: red }', H)
    expect(out).toContain(`.dark .btn${A}`)
  })

  it('renames @keyframes and rewrites animation references', () => {
    const css = `@keyframes spin { from { opacity: 0 } to { opacity: 1 } }
.x { animation: spin 1s linear }
.y { animation-name: spin }`
    const out = scopeCss(css, H)
    expect(out).toContain(`@keyframes spin-${H}`)
    expect(out).toContain(`animation: spin-${H} 1s linear`)
    expect(out).toContain(`animation-name: spin-${H}`)
    // keyframe step selectors (from/to) are not attribute-scoped
    expect(out).not.toContain(`from${A}`)
  })

  it('scopes selectors inside @media', () => {
    const out = scopeCss('@media (min-width: 600px) { .btn { color: red } }', H)
    expect(out).toContain(`.btn${A}`)
  })

  it('puts the scope attribute INSIDE :where(), preserving its zero specificity', () => {
    // :where()'s whole point is always-zero specificity — an author reaches
    // for it so a rule (a component library's own baseline, say) stays
    // trivially overridable. Appending the attribute AFTER :where(...)
    // instead of inside it would add a real specificity point and silently
    // defeat that: `:where(img)[data-s-h]` is no longer zero-specificity,
    // `:where(img[data-s-h])` still is.
    const out = scopeCss(':where(img) { display: block }', H)
    expect(out).toContain(`:where(img${A})`)
    expect(out).not.toContain(`:where(img)${A}`)
  })

  it('handles multiple :where() arguments, attribute on each', () => {
    const out = scopeCss(':where(img, picture) { display: block }', H)
    expect(out).toContain(`:where(img${A}, picture${A})`)
  })

  it('still scopes a non-subject ancestor normally when the subject is :where()', () => {
    const out = scopeCss('.card :where(img) { display: block }', H)
    expect(out).toContain(`.card :where(img${A})`)
    expect(out).not.toContain(`.card${A}`)
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
    expect(out).toContain('variant-picker[data-s-h1]')
    expect(out).toContain('[data-s-h1] .swatch')
    expect(out).toContain('[data-s-h1] .swatch.is-on:hover')
    // :global escapes scoping entirely
    expect(out).toContain('body .row')
    expect(out).not.toContain('[data-s-h1] body')
  })
})
