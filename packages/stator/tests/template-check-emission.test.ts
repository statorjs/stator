import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    expect(dts).toContain('at?: number | __SReadResult<number>')
    expect(dts).toContain('clock?: string | __SReadResult<string>')
    expect(dts).toContain('live?: boolean | __SReadResult<boolean>')
    expect(dts).toContain(
      "import type { ReadResult as __SReadResult } from '@statorjs/stator/template'",
    )
  })

  it('components with Stator.props keep their declared type', () => {
    const src = `---
const { name } = Stator.props<{ name: string }>()
---
<p>{name}</p>
`
    expect(generateDts(src)).toContain('(props: { name: string })')
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
    expect(checks).toBe(1)
    const emitted = await readFile(join(root, '.stator/check/layout.stator.check.tsx'), 'utf8')
    expect(emitted).toContain('<meta charset="utf-8" />')
    expect(emitted).toContain('<input name="q" />')
    expect(emitted).toContain('<br />')
    expect(emitted).not.toMatch(/<br>/)
  })
})
