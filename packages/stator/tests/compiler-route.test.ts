import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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

    assert.ok(serverCode.includes("import { defineRoute } from '@statorjs/stator/server'"))
    assert.ok(serverCode.includes('export const GET = defineRoute({'))
    assert.ok(serverCode.includes('reads: [CartMachine, ProductsMachine],'))
    assert.ok(serverCode.includes('render: (__ctx, __req) => {'))
    // positional binding via runtime machine .name keys
    assert.ok(
      serverCode.includes(
        'const [cart, products] = [__ctx[CartMachine.name], __ctx[ProductsMachine.name]]',
      ),
    )
    assert.ok(serverCode.includes('return html`'))
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
    assert.ok(serverCode.includes('live: true,'))
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
    assert.ok(serverCode.includes("const lang = __req.headers.get('accept-language')"))
    assert.ok(serverCode.includes("__ctx.response.headers.set('x-test', '1')"))
  })

  it('errors on an unknown pragma', () => {
    const src = `---\n// @stator liev\n---\n<p>x</p>`
    assert.throws(() => compile(src, { id: 'routes/x.stator', kind: 'route' }), /unknown pragma/)
  })

  describe('capability matrix', () => {
    it('errors: Stator.reads in a component', () => {
      const src = `---\nconst [x] = Stator.reads([M])\n---\n<p/>`
      assert.throws(() => compile(src, { kind: 'component' }), /only available in a route/)
    })
    it('errors: Stator.props in a route', () => {
      const src = `---\nconst { x } = Stator.props<{ x: number }>()\n---\n<p>{x}</p>`
      assert.throws(() => compile(src, { kind: 'route' }), /not available in a route/)
    })
    it('errors: Stator.request in a component', () => {
      const src = `---\nconst h = Stator.request.headers\n---\n<p/>`
      try {
        compile(src, { kind: 'component' })
        throw new Error('expected throw')
      } catch (e) {
        assert.ok(e instanceof CompileError)
        assert.ok((e as CompileError).message.includes('only available in a route'))
      }
    })
    it('errors: // @stator live in a component', () => {
      const src = `---\n// @stator live\n---\n<p/>`
      assert.throws(() => compile(src, { kind: 'component' }), /only valid in a route/)
    })
  })
})
