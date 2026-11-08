// @env happy-dom
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as clientApi from '../src/client/index.ts'
import { generateDts, statorPropsType } from '../src/compiler/dts.ts'
import {
  CLIENT_AUTHOR_GLOBALS,
  CLIENT_LOWERING_TARGETS,
  ISLAND_SHELL_EXTRAS,
  TEMPLATE_AUTHOR_GLOBALS,
  TEMPLATE_LOWERING_TARGETS,
} from '../src/compiler/emit-names.ts'
import { splitStator } from '../src/compiler/split.ts'
import { toVirtualCode } from '../src/compiler/virtual-code.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import { html } from '../src/template/html.ts'
import * as templateApi from '../src/template/index.ts'
import { attrValue, setAttr, textValue } from '../src/wire/attr-value.ts'

/**
 * Seam tests — the same contract implemented on two tiers must be pinned
 * EQUAL, not re-implemented and hoped identical. Three starter-found bugs
 * were seam disagreements (see ROADMAP → surface hygiene → seam
 * consolidation); these tests walk the seams so a starter doesn't have to.
 */

const VALUES: unknown[] = [false, true, null, undefined, '', 'x', 0, 3, ['a', 'b'], 'y z']

describe('seam: static attr render ≡ patch-applied attr', () => {
  for (const [v] of VALUES.map((v) => [v] as [unknown]))
    it(`value ${JSON.stringify(v)} agrees on both tiers`, () => {
      // Static tier: render the attribute through html``.
      const state = createRenderState('seam', 'GET /probe')
      const rendered = runInRender(state, () => html`<div data-x="${v}"></div>`).html
      const holder = document.createElement('div')
      holder.innerHTML = rendered
      const staticEl = holder.firstElementChild as Element

      // Patch tier: apply the same value through the shared wire contract
      // (recompute normalizes with attrValue; apply.ts writes with setAttr).
      const patchEl = document.createElement('div')
      setAttr(patchEl, 'data-x', attrValue(v))

      assert.equal(staticEl.hasAttribute('data-x'), patchEl.hasAttribute('data-x'))
      assert.equal(staticEl.getAttribute('data-x'), patchEl.getAttribute('data-x'))
    })
})

describe('seam: static text render ≡ text patch value', () => {
  for (const [v] of VALUES.map((v) => [v] as [unknown]))
    it(`value ${JSON.stringify(v)} agrees on both tiers`, () => {
      const state = createRenderState('seam-t', 'GET /probe')
      const rendered = runInRender(state, () => html`<p>${v}</p>`).html
      const holder = document.createElement('div')
      holder.innerHTML = rendered
      // The patch tier sets textContent to textValue(v) — the same function
      // the static tier interpolates with (arrays join, null empties).
      assert.equal((holder.firstElementChild as Element).textContent, textValue(v))
    })
})

describe('seam: .d.ts props ≡ language-server virtual props', () => {
  const CASES: Array<[name: string, source: string]> = [
    [
      'island with static attrs',
      `<row-seats>
  <input value={props.seats} />
</row-seats>
<script>
  export class RowSeats extends StatorElement {
    static attrs = { rid: String, seats: Number }
  }
</script>`,
    ],
    [
      'island with NO static attrs',
      `<reg-form>
  <select>{props.tickets.map((t) => <option>{t}</option>)}</select>
</reg-form>
<script>
  export class RegForm extends StatorElement {}
</script>`,
    ],
    [
      'island with a server fence (fence must not perturb the props contract)',
      `---
import { TICKETS } from './rules.ts'
const first = TICKETS[0]
---
<fenced-form>
  <p>{first}</p>
  <input value={props.seats} />
</fenced-form>
<script>
  export class FencedForm extends StatorElement {
    static attrs = { seats: Number }
  }
</script>`,
    ],
    [
      'server component with Stator.props',
      `---
const { title } = Stator.props<{ title: string }>()
---
<h1>{title}</h1>`,
    ],
    ['static component', '<p>static</p>'],
  ]

  for (const [_name, source] of CASES)
    it(`${_name}: the .d.ts carries exactly the shared props type`, () => {
      // The .d.ts must carry exactly what statorPropsType computes — the same
      // function buildServerTsx types its default export with. (Island virtual
      // code is the SCRIPT module — importers see the .d.ts — so the .d.ts is
      // the caller-facing contract on both CLI and editor tiers.)
      const { frontmatter, template, scripts } = splitSource(source)
      const { propsT } = statorPropsType(frontmatter, template, scripts)
      const dts = generateDts(source, { kind: 'component' })
      assert.ok(dts)
      assert.ok(dts.includes(`(props: ${propsT})`))
    })

  it('SERVER-component virtual code types its export with the same props type', () => {
    const source = CASES[3]![1]
    const { frontmatter, template, scripts } = splitSource(source)
    const { propsT } = statorPropsType(frontmatter, template, scripts)
    assert.ok(toVirtualCode(source).tsx.code.includes(`(_props: ${propsT})`))
  })

  it('an attrs-less island accepts arbitrary shell props', () => {
    const source = CASES[1]![1]
    assert.ok(generateDts(source, { kind: 'component' }))
    assert.ok(generateDts(source, { kind: 'component' })!.includes('{ [prop: string]: unknown }'))
  })

  it("an island's fence is typed in the client virtual code, deduped against script imports", () => {
    const source = `---
import { TICKETS } from './rules.ts'
import { helper } from './shared.ts'
const first = TICKETS[0]
---
<fenced-form><p>{first}</p></fenced-form>
<script>
  import { helper } from './shared.ts'
  export class FencedForm extends StatorElement {}
</script>`
    const { code } = toVirtualCode(source).tsx
    assert.ok(code.includes("import { TICKETS } from './rules.ts'"))
    assert.ok(code.includes('const first = TICKETS[0]'))
    // The shared import appears once — the script's copy wins.
    assert.equal(code.match(/import \{ helper \} from '\.\/shared\.ts'/g)?.length, 1)
  })

  it('a server component with an inline script does NOT take the island branch', () => {
    const { propsT } = statorPropsType('', '<p>static</p>', ['console.log("inline")'])
    assert.equal(propsT, 'Record<string, never>')
  })
})

describe('seam: emitted import names ≡ runtime module exports', () => {
  // The emitters and the LSP now share one name list (emit-names.ts); this
  // pins the remaining seam — every name they inject must actually exist on
  // the runtime module the emitted import resolves to.
  it('every template name the compiler injects is a real template export', () => {
    for (const n of [
      ...TEMPLATE_AUTHOR_GLOBALS,
      ...TEMPLATE_LOWERING_TARGETS,
      ...ISLAND_SHELL_EXTRAS,
    ]) {
      assert.ok(n in templateApi, n)
    }
  })

  it('every client name the compiler injects is a real client export', () => {
    for (const n of [...CLIENT_AUTHOR_GLOBALS, ...CLIENT_LOWERING_TARGETS]) {
      assert.ok(n in clientApi, n)
    }
  })
})

function splitSource(source: string): { frontmatter: string; template: string; scripts: string[] } {
  const { frontmatter, template, scripts } = splitStator(source)
  return { frontmatter, template, scripts }
}
