import { describe, expect, it } from 'vitest'
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
    expect(generated).toBe(original)
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
    expect(
      src.slice(
        r.frontmatter!.contentOffset,
        r.frontmatter!.contentOffset + r.frontmatter!.content.length,
      ),
    ).toBe(r.frontmatter!.content)
    expect(r.frontmatter!.content).toContain('Stator.reads')
    expect(
      src.slice(r.template.contentOffset, r.template.contentOffset + r.template.content.length),
    ).toBe(r.template.content)
    expect(r.template.content).toContain('read(cart')
    expect(r.styles).toHaveLength(1)
    expect(
      src.slice(
        r.styles[0]!.contentOffset,
        r.styles[0]!.contentOffset + r.styles[0]!.content.length,
      ),
    ).toBe('.x { color: red }')
  })

  it('excludes is:inline / src scripts (matches splitStator classification)', () => {
    const src = `<div>page</div>
<script is:inline>if (a) { b() }</script>
<script>export class Foo extends StatorElement {}</script>`
    const r = scanRegions(src)
    expect(r.scripts).toHaveLength(1)
    expect(r.scripts[0]!.content).toContain('class Foo')
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
    expect(tsx.code).toContain('Stator.reads([CartMachine])')
    expect(tsx.code).toContain('read(cart, c => c.total)')
    // Template globals imported so `read` resolves.
    expect(tsx.code).toContain("from '@statorjs/stator/template'")
    // Every mapping is a faithful source↔generated run.
    assertMappingsFaithful(src, tsx)
    // The CSS block became its own faithfully-mapped virtual file.
    expect(styles).toHaveLength(1)
    expect(styles[0]!.lang).toBe('css')
    expect(styles[0]!.code).toBe('.cart { color: var(--text) }')
    assertMappingsFaithful(src, styles[0]!)
  })

  it('maps a template token back to its exact source position', () => {
    const { tsx } = toVirtualCode(src)
    // Find `cart` inside the template's read() in the generated code, map it back.
    const genIdx = tsx.code.indexOf('read(cart') + 'read('.length
    const m = tsx.mappings.find(
      (m) => genIdx >= m.generatedOffset && genIdx < m.generatedOffset + m.length,
    )!
    expect(m).toBeTruthy()
    const srcIdx = m.sourceOffset + (genIdx - m.generatedOffset)
    expect(src.slice(srcIdx, srcIdx + 4)).toBe('cart')
  })

  it('drops a leading <!doctype> from the shell but still maps the rest', () => {
    const doc = `<!doctype html>
<html><body>{read(cart, c => c.n)}</body></html>`
    const { tsx } = toVirtualCode(doc)
    expect(tsx.code).not.toContain('<!doctype')
    expect(tsx.code).toContain('read(cart, c => c.n)')
    assertMappingsFaithful(doc, tsx)
  })
})

describe('toVirtualCode — client component', () => {
  const src = `<theme-toggle>
  <button on:click={toggle}><span bind:text={theme.label}></span></button>
</theme-toggle>

<script>
  const Theme = machine({ mode: 'light', on: { TOGGLE: (s) => {} } })
  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>

<style>.theme-toggle-btn { color: var(--text) }</style>`

  it('emits the script as the module, faithfully mapped, with client imports', () => {
    const { tsx, styles } = toVirtualCode(src)
    expect(tsx.code).toContain('export class ThemeToggle extends StatorElement')
    expect(tsx.code).toContain("from '@statorjs/stator/client'")
    assertMappingsFaithful(src, tsx)
    expect(styles).toHaveLength(1)
    assertMappingsFaithful(src, styles[0]!)
  })
})
