import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompileError, lowerTemplate } from '../src/compiler/lower.ts'

describe('compiler: lowerTemplate (JSX → html`` expression)', () => {
  it('lowers text and a read interpolation', () => {
    assert.equal(
      lowerTemplate('<div class="cart">Total: {read(cart, c => c.total)}</div>'),
      'html`<div class="cart">Total: ${read(cart, c => c.total)}</div>`',
    )
  })

  it('lowers a bare expression as a one-shot interpolation', () => {
    assert.equal(lowerTemplate('<p>{name}</p>'), 'html`<p>${name}</p>`')
  })

  it('lowers attribute-value expressions to ${...} interpolation', () => {
    assert.equal(lowerTemplate('<a href={url}>x</a>'), 'html`<a href="${url}">x</a>`')
  })

  it('preserves string attributes and boolean attributes', () => {
    assert.equal(
      lowerTemplate('<input type="text" disabled />'),
      'html`<input type="text" disabled>`',
    )
  })

  it('closes a self-closing non-void element (browsers read <div /> as an open tag)', () => {
    assert.equal(
      lowerTemplate('<div aria-current={cur} />'),
      'html`<div aria-current="${cur}"></div>`',
    )
    assert.equal(lowerTemplate('<my-widget />'), 'html`<my-widget></my-widget>`')
    assert.equal(lowerTemplate('<p><br /><img src="x" /></p>'), 'html`<p><br><img src="x"></p>`')
  })

  it('lowers on: directives to on(event, handler) calls', () => {
    assert.equal(
      lowerTemplate('<button on:click={() => cart.send({ type: "ADD" })}>Add</button>'),
      'html`<button ${on("click", () => cart.send({ type: "ADD" }))}>Add</button>`',
    )
  })

  it('lowers class:list and style:list directives', () => {
    assert.equal(
      lowerTemplate('<div class:list={{ active: on }}></div>'),
      'html`<div ${classList({ active: on })}></div>`',
    )
    assert.equal(
      lowerTemplate('<div style:list={{ color }}></div>'),
      'html`<div ${styleList({ color })}></div>`',
    )
  })

  it('lowers each() with a nested element body (recursive html``)', () => {
    assert.equal(
      lowerTemplate('<ul>{each(items, (i) => <li>{i.name}</li>)}</ul>'),
      'html`<ul>${each(items, (i) => html`<li>${i.name}</li>`)}</ul>`',
    )
  })

  it('lowers when() with a nested element body', () => {
    assert.equal(
      lowerTemplate('<div>{when(open, () => <p>shown</p>)}</div>'),
      'html`<div>${when(open, () => html`<p>shown</p>`)}</div>`',
    )
  })

  it('escapes literal $ and backticks in text', () => {
    assert.equal(
      lowerTemplate('<span>Price: $5 `code`</span>'),
      'html`<span>Price: \\$5 \\`code\\`</span>`',
    )
  })

  it('preserves a leading <!doctype> (not valid JSX)', () => {
    assert.equal(
      lowerTemplate('<!doctype html>\n<html><body>{x}</body></html>'),
      'html`<!doctype html><html><body>${x}</body></html>`',
    )
  })

  it('rejects bind: (removed in 2.0) and unknown directives', () => {
    assert.throws(() => lowerTemplate('<span bind:text={x}></span>'), CompileError)
  })
})
