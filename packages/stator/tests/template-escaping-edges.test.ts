import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { spreadAttrs } from '../src/template/directives/spread.ts'
import { html } from '../src/template/html.ts'

const render = (fn: () => { html: string }): string =>
  runInRender(createRenderState('s', 'GET /'), fn).html

describe('template escaping edges', () => {
  it('checks a URL attribute whole when its scheme is split across interpolations', () => {
    const a = 'java'
    const b = 'script:alert(1)'
    assert.match(
      render(() => html`<a href="${a}${b}">x</a>`),
      /<a[^>]* href="">x<\/a>/,
    )
    assert.match(
      render(() => html`<a href="java${b}">x</a>`),
      /<a[^>]* href="">x<\/a>/,
    )
  })

  it('leaves an ordinary URL built from pieces alone', () => {
    const path = '/search'
    const q = '?q=a&b'
    assert.ok(render(() => html`<a href="${path}${q}">x</a>`).includes('href="/search?q=a&amp;b"'))
  })

  it('guards data, manifest and srcset like href', () => {
    const bad = 'javascript:alert(1)'
    const out = render(() => html`<object data="${bad}"></object><img srcset="${bad}" />`)
    assert.ok(!out.includes('javascript:'), out)
  })

  it('drops spread keys that are not attribute names, and event handlers', () => {
    const bag = {
      title: 'kept',
      onclick: 'alert(1)',
      ONLOAD: 'x',
      'x"><script>': 'y',
      'data-ok': 'z',
    }
    const out = render(() => html`<div ${spreadAttrs(bag)}></div>`)
    assert.ok(out.includes('title="kept"'))
    assert.ok(out.includes('data-ok="z"'))
    assert.ok(!/onclick|onload|<script>/i.test(out), out)
  })
})
