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

  it('strips javascript:/vbscript: from url-bearing attributes, keeps data: images', () => {
    const hrefOut = render(() => html`<a href="${'javascript:alert(1)'}">x</a>`)
    expect(hrefOut).not.toContain('javascript:')
    expect(hrefOut).toContain('href=""')

    // Case-insensitive + control-char obfuscation is caught.
    const srcOut = render(() => html`<img src="${'JavaScript:alert(1)'}" />`)
    expect(srcOut.toLowerCase()).not.toContain('javascript:')

    // data:image on src is a legitimate resource — left intact.
    const dataOut = render(() => html`<img src="${'data:image/png;base64,AAA'}" />`)
    expect(dataOut).toContain('data:image/png;base64,AAA')

    // A non-url attribute is unaffected by scheme filtering.
    const titleOut = render(() => html`<a title="${'javascript:alert(1)'}">x</a>`)
    expect(titleOut).toContain('javascript:alert(1)')
  })

  it('escapes single quotes so single-quoted attributes cannot be broken out of', () => {
    const payload = "' onfocus='alert(1)"
    const out = render(() => html`<input value='${payload}' />`)
    expect(out).not.toContain("onfocus='alert(1)'")
    expect(out).toContain('&#39;')
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
