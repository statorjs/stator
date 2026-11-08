import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { syncTypes } from '../src/build/sync.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '.tmp-sync-app')

after(() => rm(root, { recursive: true, force: true }))

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('build: syncTypes', () => {
  it('writes mirrored .d.ts into .stator/types, skipping routes, never next to source', async () => {
    await mkdir(join(root, 'templates'), { recursive: true })
    await mkdir(join(root, 'routes'), { recursive: true })
    await writeFile(
      join(root, 'templates/card.stator'),
      `---\nconst { title } = Stator.props<{ title: string }>()\n---\n<div>{title}</div>`,
    )
    await writeFile(
      join(root, 'routes/index.stator'),
      `---\nconst [m] = Stator.reads([M])\n---\n<p>x</p>`,
    )

    const result = await syncTypes(root)
    assert.equal(result.written, 1) // route skipped

    // Mirrored under .stator/types, NOT next to source.
    assert.equal(await exists(join(root, '.stator/types/templates/card.stator.d.ts')), true)
    assert.equal(await exists(join(root, 'templates/card.stator.d.ts')), false)
    // Routes get no .d.ts.
    assert.equal(await exists(join(root, '.stator/types/routes/index.stator.d.ts')), false)

    const dts = await readFile(join(root, '.stator/types/templates/card.stator.d.ts'), 'utf8')
    assert.ok(dts.includes('(props: { title: string }) => HtmlFragment'))
  })
})
