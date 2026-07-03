import { describe, expect, it } from 'vitest'
import { compile } from '../src/compiler/compile.ts'
import { CompileError } from '../src/compiler/diagnostics.ts'

describe('compiler: route pages (stage 3)', () => {
  it('compiles a route .stator to GET = defineRoute with reads + render', () => {
    const src = `---
import CartMachine from '../machines/cart.ts'
import ProductsMachine from '../machines/products.ts'
import CustomerLayout from '../templates/customer-layout.stator'
import ProductList from '../templates/product-list.stator'

const [cart, products] = Stator.reads([CartMachine, ProductsMachine])
---
<CustomerLayout cart={cart}><ProductList products={products} cart={cart} /></CustomerLayout>`

    const { serverCode } = compile(src, {
      id: 'routes/index.stator',
      kind: 'route',
    })

    expect(serverCode).toContain("import { defineRoute } from '@statorjs/stator/server'")
    expect(serverCode).toContain('export const GET = defineRoute({')
    expect(serverCode).toContain('reads: [CartMachine, ProductsMachine],')
    expect(serverCode).toContain('render: (__ctx, __req) => {')
    // positional binding via runtime machine .name keys
    expect(serverCode).toContain(
      'const [cart, products] = [__ctx[CartMachine.name], __ctx[ProductsMachine.name]]',
    )
    expect(serverCode).toContain('return html`')
  })

  it('emits live: true for the // @stator live pragma', () => {
    const src = `---
// @stator live
import AdminMachine from '../machines/admin.ts'
const [admin] = Stator.reads([AdminMachine])
---
<div>{read(admin, a => a.activeCartCount)}</div>`
    const { serverCode } = compile(src, {
      id: 'routes/admin.stator',
      kind: 'route',
    })
    expect(serverCode).toContain('live: true,')
  })

  it('rewrites Stator.request / Stator.response in a route', () => {
    const src = `---
const lang = Stator.request.headers.get('accept-language')
Stator.response.headers.set('x-test', '1')
---
<p>{lang}</p>`
    const { serverCode } = compile(src, {
      id: 'routes/x.stator',
      kind: 'route',
    })
    expect(serverCode).toContain("const lang = __req.headers.get('accept-language')")
    expect(serverCode).toContain("__ctx.response.headers.set('x-test', '1')")
  })

  it('errors on an unknown pragma', () => {
    const src = `---\n// @stator liev\n---\n<p>x</p>`
    expect(() => compile(src, { id: 'routes/x.stator', kind: 'route' })).toThrow(/unknown pragma/)
  })

  describe('capability matrix', () => {
    it('errors: Stator.reads in a component', () => {
      const src = `---\nconst [x] = Stator.reads([M])\n---\n<p/>`
      expect(() => compile(src, { kind: 'component' })).toThrow(/only available in a route/)
    })
    it('errors: Stator.props in a route', () => {
      const src = `---\nconst { x } = Stator.props<{ x: number }>()\n---\n<p>{x}</p>`
      expect(() => compile(src, { kind: 'route' })).toThrow(/not available in a route/)
    })
    it('errors: Stator.request in a component', () => {
      const src = `---\nconst h = Stator.request.headers\n---\n<p/>`
      try {
        compile(src, { kind: 'component' })
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(CompileError)
        expect((e as CompileError).message).toContain('only available in a route')
      }
    })
    it('errors: // @stator live in a component', () => {
      const src = `---\n// @stator live\n---\n<p/>`
      expect(() => compile(src, { kind: 'component' })).toThrow(/only valid in a route/)
    })
  })
})
