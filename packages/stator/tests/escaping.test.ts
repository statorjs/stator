import { describe, expect, it } from 'vitest'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { each } from '../src/template/each.ts'
import { html } from '../src/template/html.ts'
import { raw } from '../src/template/index.ts'

const XSS = '<script>alert(1)</script>'

function render(fn: () => { html: string }): string {
  return runInRender(createRenderState('esc', 'GET /'), fn).html
}

describe('template escaping (XSS)', () => {
  it('escapes script tags interpolated at text positions', () => {
    const out = render(() => html`<p>${XSS}</p>`)
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes attribute breakouts (quotes and angle brackets)', () => {
    const payload = '" onmouseover="alert(1)'
    const out = render(() => html`<div title="${payload}">x</div>`)
    expect(out).not.toContain('onmouseover="alert(1)"')
    expect(out).toContain('&quot;')
  })

  it('escapes hostile content inside each() items', () => {
    const items = [{ label: XSS }]
    const out = render(() => html`<ul>${each(items, (i) => html`<li>${i.label}</li>`)}</ul>`)
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('escapes hostile content inside keyed each() items', () => {
    const items = [{ id: 'a', label: XSS }]
    const out = render(
      () => html`<ul>${each(items, (i) => html`<li>${i.label}</li>`, { key: (i) => i.id })}</ul>`,
    )
    expect(out).not.toContain('<script>')
  })

  it('escapes javascript: payloads the same as any text (no URL allowlisting yet)', () => {
    const out = render(() => html`<a href="${'javascript:alert(1)'}">x</a>`)
    // Attribute escaping neutralizes breakouts; scheme filtering is the
    // author's job (documented) — assert the value can't escape the attr.
    expect(out).toContain('href="javascript:alert(1)"')
    expect(out.split('href').length).toBe(2)
  })

  it('raw() bypasses escaping — the one documented unsafe seam', () => {
    const out = render(() => html`<div>${raw('<b>trusted</b>')}</div>`)
    expect(out).toContain('<b>trusted</b>')
  })

  it('escapes nested quotes in list item attributes', () => {
    const items = [{ id: 'a"b', cls: '"><img src=x onerror=alert(1)>' }]
    const out = render(
      () => html`<ul>${each(items, (i) => html`<li class="${i.cls}">x</li>`)}</ul>`,
    )
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror=alert(1)>')
  })
})
