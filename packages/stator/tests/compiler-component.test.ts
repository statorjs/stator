import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lowerTemplate } from '../src/compiler/lower.ts'

describe('compiler: component invocation (stage 1)', () => {
  it('lowers a self-closing component to a call with props', () => {
    assert.equal(
      lowerTemplate('<ProductList products={x} cart={y} />'),
      'html`${ProductList({ products: x, cart: y })}`',
    )
  })

  it('lowers string and boolean props', () => {
    assert.equal(
      lowerTemplate('<Card title="Hi" featured />'),
      'html`${Card({ title: "Hi", featured: true })}`',
    )
  })

  it('lowers a component with no props', () => {
    assert.equal(lowerTemplate('<Footer />'), 'html`${Footer({  })}`')
  })

  it('passes default children in a children bag', () => {
    assert.equal(
      lowerTemplate('<Layout cart={c}><ProductList products={p} /></Layout>'),
      'html`${Layout({ cart: c, children: { default: html`${ProductList({ products: p })}` } })}`',
    )
  })

  it('passes mixed element + component children', () => {
    assert.equal(
      lowerTemplate('<Layout><h1>Title</h1><Body /></Layout>'),
      'html`${Layout({ children: { default: html`<h1>Title</h1>${Body({  })}` } })}`',
    )
  })

  it('treats lowercase and hyphenated tags as HTML, not components', () => {
    assert.equal(
      lowerTemplate('<div><counter-widget></counter-widget></div>'),
      'html`<div><counter-widget></counter-widget></div>`',
    )
  })

  it('collects an on: directive on a component into a $directives bag (forwarding)', () => {
    assert.equal(
      lowerTemplate('<Button on:click={h} />'),
      'html`${Button({ $directives: { "on:click": h } })}`',
    )
  })

  it('keeps on: forwarding alongside normal props', () => {
    assert.equal(
      lowerTemplate('<Button variant="primary" on:click={h} />'),
      'html`${Button({ variant: "primary", $directives: { "on:click": h } })}`',
    )
  })

  it('still rejects ref: forwarding to a component (on:* only, for now)', () => {
    assert.throws(() => lowerTemplate('<Button bind:value={v} />'), /removed in 2\.0/)
  })

  it('lowers spread props on a component to an object spread', () => {
    assert.equal(lowerTemplate('<Card {...rest} />'), 'html`${Card({ ...rest })}`')
  })

  it('keeps spread + explicit props in source order (explicit overrides spread)', () => {
    assert.equal(
      lowerTemplate('<Card {...rest} title="Hi" />'),
      'html`${Card({ ...rest, title: "Hi" })}`',
    )
  })

  it('lowers a spread on an element to a spreadAttrs directive', () => {
    assert.equal(
      lowerTemplate('<button {...rest} />'),
      'html`<button ${spreadAttrs(rest)}></button>`',
    )
  })

  it('keeps element spread in source order among static attributes', () => {
    assert.equal(
      lowerTemplate('<button type="submit" {...rest} disabled />'),
      'html`<button type="submit" ${spreadAttrs(rest)} disabled></button>`',
    )
  })

  it('lowers a component inside an each callback', () => {
    assert.equal(
      lowerTemplate('<ul>{each(items, (i) => <Item data={i} />)}</ul>'),
      'html`<ul>${each(items, (i) => html`${Item({ data: i })}`)}</ul>`',
    )
  })
})
