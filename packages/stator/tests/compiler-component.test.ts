import { describe, expect, it } from 'vitest'
import { CompileError } from '../src/compiler/diagnostics.ts'
import { lowerTemplate } from '../src/compiler/lower.ts'

describe('compiler: component invocation (stage 1)', () => {
  it('lowers a self-closing component to a call with props', () => {
    expect(lowerTemplate('<ProductList products={x} cart={y} />')).toBe(
      'html`${ProductList({ products: x, cart: y })}`',
    )
  })

  it('lowers string and boolean props', () => {
    expect(lowerTemplate('<Card title="Hi" featured />')).toBe(
      'html`${Card({ title: "Hi", featured: true })}`',
    )
  })

  it('lowers a component with no props', () => {
    expect(lowerTemplate('<Footer />')).toBe('html`${Footer({  })}`')
  })

  it('passes default children in a children bag', () => {
    expect(lowerTemplate('<Layout cart={c}><ProductList products={p} /></Layout>')).toBe(
      'html`${Layout({ cart: c, children: { default: html`${ProductList({ products: p })}` } })}`',
    )
  })

  it('passes mixed element + component children', () => {
    expect(lowerTemplate('<Layout><h1>Title</h1><Body /></Layout>')).toBe(
      'html`${Layout({ children: { default: html`<h1>Title</h1>${Body({  })}` } })}`',
    )
  })

  it('treats lowercase and hyphenated tags as HTML, not components', () => {
    expect(lowerTemplate('<div><counter-widget></counter-widget></div>')).toBe(
      'html`<div><counter-widget></counter-widget></div>`',
    )
  })

  it('collects an on: directive on a component into a $directives bag (forwarding)', () => {
    expect(lowerTemplate('<Button on:click={h} />')).toBe(
      'html`${Button({ $directives: { "on:click": h } })}`',
    )
  })

  it('keeps on: forwarding alongside normal props', () => {
    expect(lowerTemplate('<Button variant="primary" on:click={h} />')).toBe(
      'html`${Button({ variant: "primary", $directives: { "on:click": h } })}`',
    )
  })

  it('still rejects bind:/ref: forwarding to a component (on:* only, for now)', () => {
    expect(() => lowerTemplate('<Button bind:value={v} />')).toThrow(CompileError)
  })

  it('lowers spread props on a component to an object spread', () => {
    expect(lowerTemplate('<Card {...rest} />')).toBe('html`${Card({ ...rest })}`')
  })

  it('keeps spread + explicit props in source order (explicit overrides spread)', () => {
    expect(lowerTemplate('<Card {...rest} title="Hi" />')).toBe(
      'html`${Card({ ...rest, title: "Hi" })}`',
    )
  })

  it('lowers a spread on an element to a spreadAttrs directive', () => {
    expect(lowerTemplate('<button {...rest} />')).toBe('html`<button ${spreadAttrs(rest)} />`')
  })

  it('keeps element spread in source order among static attributes', () => {
    expect(lowerTemplate('<button type="submit" {...rest} disabled />')).toBe(
      'html`<button type="submit" ${spreadAttrs(rest)} disabled />`',
    )
  })

  it('lowers a component inside an each callback', () => {
    expect(lowerTemplate('<ul>{each(items, (i) => <Item data={i} />)}</ul>')).toBe(
      'html`<ul>${each(items, (i) => html`${Item({ data: i })}`)}</ul>`',
    )
  })
})
