// Finding #5 / item-value bindings: `read(item, selector)` inside an each lowers
// to a per-row itemBind. `read()` stays the one live marker — a plain
// `{item.field}` renders once. The runtime is covered by
// each-item-bindings.test.ts / each-keyed-item-bindings.test.ts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lowerTemplate } from '../src/compiler/lower.ts'

describe('lower: item-value bindings via read(item, …)', () => {
  it('lowers read(item, selector) to itemBind(selector)', () => {
    assert.equal(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>)}</ul>',
      ),
      'html`<ul>${each(read(m, s => s.rows), (r) => html`<li>${itemBind((x) => x.label)}</li>`)}</ul>`',
    )
  })

  it('leaves a plain {item.field} static — it renders once, per the doctrine', () => {
    const out = lowerTemplate('<ul>{each(read(m, s => s.rows), (r) => <li>{r.label}</li>)}</ul>')
    assert.ok(out.includes('${r.label}'))
    assert.ok(!out.includes('itemBind'))
  })

  it('leaves a machine read() untouched (first arg is not the item param)', () => {
    assert.ok(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(clock, (c) => c.now)}</li>)}</ul>',
      ).includes('${read(clock, (c) => c.now)}'),
    )
  })

  it('works in a keyed each', () => {
    assert.ok(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>, { key: (r) => r.id })}</ul>',
      ).includes('${itemBind((x) => x.label)}'),
    )
  })

  it('resolves read(item) to the nearest each — a nested each binds its own item', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.groups), (g) => <li>{read(g, (x) => x.name)}{each(g.items, (it) => <span>{read(it, (y) => y.x)}</span>)}</li>)}</ul>',
    )
    assert.ok(out.includes('${itemBind((x) => x.name)}'))
    assert.ok(out.includes('${itemBind((y) => y.x)}'))
  })

  it('coexists with raw() in the same row — no guard needed, raw stays static', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}{raw(r.icon)}</li>)}</ul>',
    )
    assert.ok(out.includes('${itemBind((x) => x.label)}'))
    assert.ok(out.includes('${raw(r.icon)}'))
  })

  it('does not treat read(item, …) as live in a client-island shell', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>)}</ul>',
      { client: { useFields: new Set<string>(), directives: [] } },
    )
    assert.ok(!out.includes('itemBind'))
  })

  it('does not rewrite read() outside any each', () => {
    assert.ok(
      lowerTemplate('<p>{read(m, (s) => s.name)}</p>').includes('${read(m, (s) => s.name)}'),
    )
  })

  it('lowers read(item, …) in attribute position — checked, class, style', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.rows), (r) => <li style={read(r, (x) => x.width)}><input type="checkbox" checked={read(r, (x) => x.done)} /></li>, { key: (r) => r.id })}</ul>',
    )
    assert.ok(out.includes('style="${itemBind((x) => x.width)}"'))
    assert.ok(out.includes('checked="${itemBind((x) => x.done)}"'))
  })
})
