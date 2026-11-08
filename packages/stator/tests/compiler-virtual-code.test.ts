import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanRegions } from '../src/compiler/split.ts'
import { toVirtualCode, type VirtualFile } from '../src/compiler/virtual-code.ts'

/**
 * The load-bearing invariant for the language-server emit: every mapping must be
 * a faithful 1:1 run — the generated slice equals the source slice. If this
 * holds, completions/diagnostics computed on the virtual code land on the right
 * source positions.
 */
function assertMappingsFaithful(source: string, file: VirtualFile): void {
  for (const m of file.mappings) {
    const generated = file.code.slice(m.generatedOffset, m.generatedOffset + m.length)
    const original = source.slice(m.sourceOffset, m.sourceOffset + m.length)
    assert.equal(generated, original)
  }
}

describe('scanRegions', () => {
  it('reports exact offsets for frontmatter, template, and style', () => {
    const src = `---
import Cart from '../machines/cart.ts'
const [cart] = Stator.reads([Cart])
---
<main>{read(cart, c => c.total)}</main>

<style>.x { color: red }</style>`
    const r = scanRegions(src)
    // Each region's content sits exactly at its reported offset.
    assert.equal(
      src.slice(
        r.frontmatter!.contentOffset,
        r.frontmatter!.contentOffset + r.frontmatter!.content.length,
      ),
      r.frontmatter!.content,
    )
    assert.ok(r.frontmatter!.content.includes('Stator.reads'))
    assert.equal(
      src.slice(r.template.contentOffset, r.template.contentOffset + r.template.content.length),
      r.template.content,
    )
    assert.ok(r.template.content.includes('read(cart'))
    assert.equal(r.styles.length, 1)
    assert.equal(
      src.slice(
        r.styles[0]!.contentOffset,
        r.styles[0]!.contentOffset + r.styles[0]!.content.length,
      ),
      '.x { color: red }',
    )
  })

  it('excludes is:inline / src scripts (matches splitStator classification)', () => {
    const src = `<div>page</div>
<script is:inline>if (a) { b() }</script>
<script>export class Foo extends StatorElement {}</script>`
    const r = scanRegions(src)
    assert.equal(r.scripts.length, 1)
    assert.ok(r.scripts[0]!.content.includes('class Foo'))
  })
})

describe('toVirtualCode — server component', () => {
  const src = `---
import CartMachine from '../machines/cart.ts'
const [cart] = Stator.reads([CartMachine])
---
<main class="cart">
  <p>Total: {read(cart, c => c.total)}</p>
</main>

<style>.cart { color: var(--text) }</style>`

  it('emits a TSX shell with frontmatter + template, faithfully mapped', () => {
    const { tsx, styles } = toVirtualCode(src)
    // Frontmatter and template both present in the shell.
    assert.ok(tsx.code.includes('Stator.reads([CartMachine])'))
    assert.ok(tsx.code.includes('read(cart, c => c.total)'))
    // Template globals imported so `read` resolves.
    assert.ok(tsx.code.includes("from '@statorjs/stator/template'"))
    // Every mapping is a faithful source↔generated run.
    assertMappingsFaithful(src, tsx)
    // The CSS block became its own faithfully-mapped virtual file.
    assert.equal(styles.length, 1)
    assert.equal(styles[0]!.lang, 'css')
    assert.equal(styles[0]!.code, '.cart { color: var(--text) }')
    assertMappingsFaithful(src, styles[0]!)
  })

  it('types the default export from Stator.props<P>() so importers get prop checking', () => {
    const component = `---
const { cart } = Stator.props<{ cart: { itemCount: number } }>()
---
<p>{cart.itemCount}</p>
`
    const { tsx } = toVirtualCode(component)
    assert.ok(
      tsx.code.includes('export default function (_props: { cart: { itemCount: number } })'),
    )
  })

  it('named props types work — the reference resolves in the same virtual module', () => {
    const component = `---
interface CardProps { title: string }
const { title } = Stator.props<CardProps>()
---
<h2>{title}</h2>
`
    const { tsx } = toVirtualCode(component)
    // The interface is in the emitted frontmatter, so the annotation resolves.
    assert.ok(tsx.code.includes('interface CardProps { title: string }'))
    assert.ok(tsx.code.includes('export default function (_props: CardProps)'))
  })

  it('a component with <children> gets a children bag; prop-less components accept none', () => {
    const layout = `---
const { cart } = Stator.props<{ cart: number }>()
---
<main><children /></main>
`
    assert.ok(
      toVirtualCode(layout).tsx.code.includes(
        'export default function (_props: { cart: number } & { children?: any })',
      ),
    )
    const plain = `<footer>bye</footer>\n`
    assert.ok(
      toVirtualCode(plain).tsx.code.includes(
        'export default function (_props: Record<string, never>)',
      ),
    )
  })

  it('maps a template token back to its exact source position', () => {
    const { tsx } = toVirtualCode(src)
    // Find `cart` inside the template's read() in the generated code, map it back.
    const genIdx = tsx.code.indexOf('read(cart') + 'read('.length
    const m = tsx.mappings.find(
      (m) => genIdx >= m.generatedOffset && genIdx < m.generatedOffset + m.length,
    )!
    assert.ok(m)
    const srcIdx = m.sourceOffset + (genIdx - m.generatedOffset)
    assert.equal(src.slice(srcIdx, srcIdx + 4), 'cart')
  })

  it('drops a leading <!doctype> from the shell but still maps the rest', () => {
    const doc = `<!doctype html>
<html><body>{read(cart, c => c.n)}</body></html>`
    const { tsx } = toVirtualCode(doc)
    assert.ok(!tsx.code.includes('<!doctype'))
    assert.ok(tsx.code.includes('read(cart, c => c.n)'))
    assertMappingsFaithful(doc, tsx)
  })
})

describe('toVirtualCode — client component', () => {
  const src = `<theme-toggle>
  <button on:click={toggle}><span>{read(theme, (t) => t.label)}</span></button>
</theme-toggle>

<script>
  const Theme = machine({ mode: 'light' }, { on: { TOGGLE: (_s) => {} } })
  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>

<style>.theme-toggle-btn { color: var(--text) }</style>`

  it('emits the script as the module, faithfully mapped, with client imports', () => {
    const { tsx, styles } = toVirtualCode(src)
    assert.ok(tsx.code.includes('export class ThemeToggle extends StatorElement'))
    assert.ok(tsx.code.includes("from '@statorjs/stator/client'"))
    assertMappingsFaithful(src, tsx)
    assert.equal(styles.length, 1)
    assertMappingsFaithful(src, styles[0]!)
  })
})

describe('virtual emit vs user imports (no duplicate identifiers)', () => {
  it('a user import of raw (not a runtime global) is never duplicated', () => {
    const src = `---
import { raw } from '@statorjs/stator/template'
---
<div>{raw('<svg/>')}</div>
`
    const { tsx } = toVirtualCode(src)
    const rawImports = tsx.code.match(/\braw\b(?=[^(]*\} from)/g) ?? []
    assert.equal(
      tsx.code.match(/import \{[^}]*\braw\b[^}]*\} from '@statorjs\/stator\/template'/g)?.length,
      1,
    )
    void rawImports
  })

  it('a habit-import of an injected global suppresses the injection', () => {
    const src = `---
import { read } from '@statorjs/stator/template'
---
<p>{read(null as never, (x) => x)}</p>
`
    const { tsx } = toVirtualCode(src)
    const importLines = tsx.code
      .split('\n')
      .filter((l) => l.includes("from '@statorjs/stator/template'"))
    const readBindings = importLines.filter((l) => /\bread\b/.test(l))
    assert.equal(readBindings.length, 1) // the user's own line only
  })

  it('client scripts: user client-module imports suppress injected duplicates', () => {
    const src = `<probe-x><p>{read(m, (x) => x.v)}</p></probe-x>
<script>
  import { dispatch } from '@statorjs/stator/client'
  const M = machine({ v: 1 })
  export class ProbeX extends StatorElement {
    m = use(M)
    go() { void dispatch }
  }
</script>`
    const { tsx } = toVirtualCode(src)
    const clientImportLines = tsx.code
      .split('\n')
      .filter((l) => l.includes("from '@statorjs/stator/client'"))
    const dispatchBindings = clientImportLines.filter((l) => /\bdispatch\b/.test(l))
    assert.equal(dispatchBindings.length, 1)
    // the other globals are still injected:
    assert.equal(
      clientImportLines.some((l) => /\bStatorElement\b/.test(l)),
      true,
    )
  })
})
