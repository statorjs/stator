import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { generateDts } from '../src/compiler/dts.ts'

describe('compiler: generateDts (typegen)', () => {
  it('emits a typed default-export signature from Stator.props', () => {
    const src = `---
import type { InstanceOf } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<div>{read(cart, c => c.itemCount)}</div>`
    const dts = generateDts(src)!
    assert.ok(dts.includes("import type { HtmlFragment } from '@statorjs/stator/template'"))
    // frontmatter type imports re-stated so the props type resolves
    assert.ok(dts.includes("import type CartMachine from '../machines/cart.ts'"))
    assert.ok(
      dts.includes(
        'declare const _default: (props: { cart: InstanceOf<typeof CartMachine> }) => HtmlFragment',
      ),
    )
    assert.ok(dts.includes('export default _default'))
  })

  it('intersects a children bag when the body uses <children>', () => {
    const src = `---
const { title } = Stator.props<{ title: string }>()
---
<section><h1>{title}</h1><children/></section>`
    assert.ok(
      generateDts(src)!.includes(
        'declare const _default: (props: { title: string } & { children?: any }) => HtmlFragment',
      ),
    )
  })

  it('handles a children-only component (no declared props)', () => {
    const dts = generateDts('<main><children/></main>')!
    assert.ok(dts.includes('(props: { children?: any }) => HtmlFragment'))
  })

  it('emits an empty props signature for a static component', () => {
    const dts = generateDts('<p>static</p>')!
    assert.ok(dts.includes('(props: Record<string, never>) => HtmlFragment'))
  })

  it('returns null for a route page', () => {
    assert.equal(generateDts('<div/>', { kind: 'route' }), null)
  })

  it('an island with NO static attrs still accepts shell props (hydrate contract)', () => {
    const src = `<reg-form>
  <select>{props.tickets.map((t) => <option>{t}</option>)}</select>
</reg-form>
<script>
  export class RegForm extends StatorElement {}
</script>`
    const dts = generateDts(src)!
    assert.ok(dts.includes('(props: { [prop: string]: unknown }) => HtmlFragment'))
    assert.ok(!dts.includes('Record<string, never>'))
  })

  it('an island declaring Stator.props is closed: its props plus its attrs', () => {
    const src = `---
import type { Row } from './rows.ts'
const { rows } = Stator.props<{ rows: Row[] }>()
---
<row-list><ul>{rows.map((r) => <li>{r.name}</li>)}</ul></row-list>
<script>
  export class RowList extends StatorElement {
    static attrs = { unitPrice: Number, open: Boolean }
  }
</script>`
    const dts = generateDts(src)!
    assert.ok(dts.includes("import type { Row } from './rows.ts'"))
    assert.ok(
      dts.includes(
        '(props: ({ rows: Row[] }) & { unitPrice?: number | __SReadResult<number>; open?: boolean | __SReadResult<boolean> }) => HtmlFragment',
      ),
    )
    assert.ok(!dts.includes('[prop: string]'))
  })
})
