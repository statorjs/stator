import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { syncTypes } from '../src/build/sync.ts'
import { generateDts } from '../src/compiler/dts.ts'

/**
 * Template internals are typecheckable in CI: sync emits each template's
 * virtual TSX under .stator/check (opt-in via tsconfig), and island d.ts
 * props derive from `static attrs` — accepting live read() bindings, which
 * the runtime has always supported but the type surface rejected.
 */

const ISLAND = `<updated-at hidden></updated-at>

<script>
  export class UpdatedAt extends StatorElement {
    static attrs = { at: Number, clock: String, live: Boolean }
  }
</script>
`

describe('island d.ts props from static attrs', () => {
  it('each attr accepts its kind or a ReadResult of it', () => {
    const dts = generateDts(ISLAND)
    assert.ok(dts?.includes('at?: number | __SReadResult<number>'))
    assert.ok(dts?.includes('clock?: string | __SReadResult<string>'))
    assert.ok(dts?.includes('live?: boolean | __SReadResult<boolean>'))
    assert.ok(
      dts?.includes("import type { ReadResult as __SReadResult } from '@statorjs/stator/template'"),
    )
  })

  it('components with Stator.props keep their declared type', () => {
    const src = `---
const { name } = Stator.props<{ name: string }>()
---
<p>{name}</p>
`
    assert.ok(generateDts(src)?.includes('(props: { name: string })'))
  })
})

describe('check-file emission', () => {
  it('emits TSX-compatible virtual code (void elements self-closed)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stator-check-'))
    await writeFile(
      join(root, 'layout.stator'),
      '<div><meta charset="utf-8"><input name="q"><br></div>\n',
    )
    const { checks } = await syncTypes(root)
    assert.equal(checks, 1)
    const emitted = await readFile(join(root, '.stator/check/layout.stator.check.tsx'), 'utf8')
    assert.ok(emitted.includes('<meta charset="utf-8" />'))
    assert.ok(emitted.includes('<input name="q" />'))
    assert.ok(emitted.includes('<br />'))
    assert.doesNotMatch(emitted, /<br>/)
  })

  it('blanks is:inline script bodies (raw JS cannot parse as TSX)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stator-check-'))
    await writeFile(
      join(root, 'page.stator'),
      '<div><script is:inline>var x = 1; for (var i = 0; i < 3; i++) x++;</script></div>\n',
    )
    await syncTypes(root)
    const emitted = await readFile(join(root, '.stator/check/page.stator.check.tsx'), 'utf8')
    assert.ok(emitted.includes('<script />'))
    assert.ok(!emitted.includes('for (var i'))
  })

  it('strips HTML comments (not valid JSX)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stator-check-'))
    await writeFile(
      join(root, 'page.stator'),
      '<div><!-- injected by the framework --><span>ok</span></div>\n',
    )
    await syncTypes(root)
    const emitted = await readFile(join(root, '.stator/check/page.stator.check.tsx'), 'utf8')
    assert.ok(!emitted.includes('<!--'))
    assert.ok(emitted.includes('<span>ok</span>'))
  })

  it('never rewrites inside attribute expressions (arrows, nested braces, strings)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stator-check-'))
    await writeFile(
      join(root, 'row.stator'),
      `<input type="checkbox" checked={read(t, (x) => x.done)} on:click={() => t.send({ type: 'GO' })} title="a > b">\n`,
    )
    await syncTypes(root)
    const emitted = await readFile(join(root, '.stator/check/row.stator.check.tsx'), 'utf8')
    assert.ok(emitted.includes('checked={read(t, (x) => x.done)}'))
    assert.ok(emitted.includes("on:click={() => t.send({ type: 'GO' })}"))
    assert.ok(emitted.includes('title="a > b" />'))
  })
})

describe('virtual-code mappings survive HTML-to-TSX edits', () => {
  it('an expression after a dropped comment and a self-closed void still maps to its true source offset', async () => {
    const { toVirtualCode } = await import('../src/compiler/virtual-code.ts')
    const src =
      '<div><!-- dropped --><meta charset="utf-8"><span>{read(m, (x) => x.y)}</span></div>\n'
    const vc = toVirtualCode(src)
    const genIdx = vc.tsx.code.indexOf('read(m,')
    assert.ok(genIdx > -1)
    const run = vc.tsx.mappings.find(
      (mm) => genIdx >= mm.generatedOffset && genIdx < mm.generatedOffset + mm.length,
    )
    assert.notEqual(run, undefined)
    const srcIdx = run!.sourceOffset + (genIdx - run!.generatedOffset)
    assert.equal(src.slice(srcIdx, srcIdx + 7), 'read(m,')
  })
})
