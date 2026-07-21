// Finding #5 / item-value bindings: `read(item, selector)` inside an each lowers
// to a per-row itemBind. `read()` stays the one live marker — a plain
// `{item.field}` renders once. The runtime is covered by
// each-item-bindings.test.ts / each-keyed-item-bindings.test.ts.
import { describe, expect, it } from 'vitest'
import { lowerTemplate } from '../src/compiler/lower.ts'

describe('lower: item-value bindings via read(item, …)', () => {
  it('lowers read(item, selector) to itemBind(selector)', () => {
    expect(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>)}</ul>',
      ),
    ).toBe(
      'html`<ul>${each(read(m, s => s.rows), (r) => html`<li>${itemBind((x) => x.label)}</li>`)}</ul>`',
    )
  })

  it('leaves a plain {item.field} static — it renders once, per the doctrine', () => {
    const out = lowerTemplate('<ul>{each(read(m, s => s.rows), (r) => <li>{r.label}</li>)}</ul>')
    expect(out).toContain('${r.label}')
    expect(out).not.toContain('itemBind')
  })

  it('leaves a machine read() untouched (first arg is not the item param)', () => {
    expect(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(clock, (c) => c.now)}</li>)}</ul>',
      ),
    ).toContain('${read(clock, (c) => c.now)}')
  })

  it('works in a keyed each', () => {
    expect(
      lowerTemplate(
        '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>, { key: (r) => r.id })}</ul>',
      ),
    ).toContain('${itemBind((x) => x.label)}')
  })

  it('resolves read(item) to the nearest each — a nested each binds its own item', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.groups), (g) => <li>{read(g, (x) => x.name)}{each(g.items, (it) => <span>{read(it, (y) => y.x)}</span>)}</li>)}</ul>',
    )
    expect(out).toContain('${itemBind((x) => x.name)}')
    expect(out).toContain('${itemBind((y) => y.x)}')
  })

  it('coexists with raw() in the same row — no guard needed, raw stays static', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}{raw(r.icon)}</li>)}</ul>',
    )
    expect(out).toContain('${itemBind((x) => x.label)}')
    expect(out).toContain('${raw(r.icon)}')
  })

  it('does not treat read(item, …) as live in a client-island shell', () => {
    const out = lowerTemplate(
      '<ul>{each(read(m, s => s.rows), (r) => <li>{read(r, (x) => x.label)}</li>)}</ul>',
      { client: { useFields: new Set<string>(), directives: [] } },
    )
    expect(out).not.toContain('itemBind')
  })

  it('does not rewrite read() outside any each', () => {
    expect(lowerTemplate('<p>{read(m, (s) => s.name)}</p>')).toContain('${read(m, (s) => s.name)}')
  })
})
