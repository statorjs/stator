import { describe, expect, it } from 'vitest'
import { CompileError, lowerTemplate } from '../src/compiler/lower.ts'

describe('compiler: lowerTemplate (JSX → html`` expression)', () => {
  it('lowers text and a read interpolation', () => {
    expect(lowerTemplate('<div class="cart">Total: {read(cart, c => c.total)}</div>')).toBe(
      'html`<div class="cart">Total: ${read(cart, c => c.total)}</div>`',
    )
  })

  it('lowers a bare expression as a one-shot interpolation', () => {
    expect(lowerTemplate('<p>{name}</p>')).toBe('html`<p>${name}</p>`')
  })

  it('lowers attribute-value expressions to ${...} interpolation', () => {
    expect(lowerTemplate('<a href={url}>x</a>')).toBe('html`<a href="${url}">x</a>`')
  })

  it('preserves string attributes and boolean attributes', () => {
    expect(lowerTemplate('<input type="text" disabled />')).toBe(
      'html`<input type="text" disabled />`',
    )
  })

  it('lowers on: directives to on(event, handler) calls', () => {
    expect(lowerTemplate('<button on:click={() => cart.send({ type: "ADD" })}>Add</button>')).toBe(
      'html`<button ${on("click", () => cart.send({ type: "ADD" }))}>Add</button>`',
    )
  })

  it('lowers class:list and style:list directives', () => {
    expect(lowerTemplate('<div class:list={{ active: on }}></div>')).toBe(
      'html`<div ${classList({ active: on })}></div>`',
    )
    expect(lowerTemplate('<div style:list={{ color }}></div>')).toBe(
      'html`<div ${styleList({ color })}></div>`',
    )
  })

  it('lowers each() with a nested element body (recursive html``)', () => {
    expect(lowerTemplate('<ul>{each(items, (i) => <li>{i.name}</li>)}</ul>')).toBe(
      'html`<ul>${each(items, (i) => html`<li>${i.name}</li>`)}</ul>`',
    )
  })

  it('lowers when() with a nested element body', () => {
    expect(lowerTemplate('<div>{when(open, () => <p>shown</p>)}</div>')).toBe(
      'html`<div>${when(open, () => html`<p>shown</p>`)}</div>`',
    )
  })

  it('escapes literal $ and backticks in text', () => {
    expect(lowerTemplate('<span>Price: $5 `code`</span>')).toBe(
      'html`<span>Price: \\$5 \\`code\\`</span>`',
    )
  })

  it('preserves a leading <!doctype> (not valid JSX)', () => {
    expect(lowerTemplate('<!doctype html>\n<html><body>{x}</body></html>')).toBe(
      'html`<!doctype html><html><body>${x}</body></html>`',
    )
  })

  it('rejects unsupported directives (bind:/ref:) until Phase 3b', () => {
    expect(() => lowerTemplate('<span bind:text={x}></span>')).toThrow(CompileError)
  })
})
