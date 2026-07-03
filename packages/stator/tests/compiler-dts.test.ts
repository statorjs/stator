import { describe, expect, it } from 'vitest'
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
    expect(dts).toContain("import type { HtmlFragment } from '@statorjs/stator/template'")
    // frontmatter type imports re-stated so the props type resolves
    expect(dts).toContain("import type CartMachine from '../machines/cart.ts'")
    expect(dts).toContain(
      'declare const _default: (props: { cart: InstanceOf<typeof CartMachine> }) => HtmlFragment',
    )
    expect(dts).toContain('export default _default')
  })

  it('intersects a children bag when the body uses <children>', () => {
    const src = `---
const { title } = Stator.props<{ title: string }>()
---
<section><h1>{title}</h1><children/></section>`
    expect(generateDts(src)!).toContain(
      'declare const _default: (props: { title: string } & { children?: any }) => HtmlFragment',
    )
  })

  it('handles a children-only component (no declared props)', () => {
    const dts = generateDts('<main><children/></main>')!
    expect(dts).toContain('(props: { children?: any }) => HtmlFragment')
  })

  it('emits an empty props signature for a static component', () => {
    const dts = generateDts('<p>static</p>')!
    expect(dts).toContain('(props: Record<string, never>) => HtmlFragment')
  })

  it('returns null for a route page', () => {
    expect(generateDts('<div/>', { kind: 'route' })).toBe(null)
  })
})
