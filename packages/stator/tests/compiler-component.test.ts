import { describe, it, expect } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'

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

  it('passes children as an html`` fragment', () => {
    expect(lowerTemplate('<Layout cart={c}><ProductList products={p} /></Layout>')).toBe(
      'html`${Layout({ cart: c, children: html`${ProductList({ products: p })}` })}`',
    )
  })

  it('passes mixed element + component children', () => {
    expect(lowerTemplate('<Layout><h1>Title</h1><Body /></Layout>')).toBe(
      'html`${Layout({ children: html`<h1>Title</h1>${Body({  })}` })}`',
    )
  })

  it('treats lowercase and hyphenated tags as HTML, not components', () => {
    expect(lowerTemplate('<div><counter-widget></counter-widget></div>')).toBe(
      'html`<div><counter-widget></counter-widget></div>`',
    )
  })

  it('errors on a directive applied to a component', () => {
    expect(() => lowerTemplate('<Button on:click={h} />')).toThrow(CompileError)
  })

  it('errors on spread props on a component', () => {
    expect(() => lowerTemplate('<Card {...rest} />')).toThrow(CompileError)
  })

  it('lowers a component inside an each callback', () => {
    expect(lowerTemplate('<ul>{each(items, (i) => <Item data={i} />)}</ul>')).toBe(
      'html`<ul>${each(items, (i) => html`${Item({ data: i })}`)}</ul>`',
    )
  })
})
