import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { syncTypes } from '../src/build/sync.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '.tmp-sync-app')

afterAll(() => rm(root, { recursive: true, force: true }))

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
    expect(result.written).toBe(1) // route skipped

    // Mirrored under .stator/types, NOT next to source.
    expect(await exists(join(root, '.stator/types/templates/card.stator.d.ts'))).toBe(true)
    expect(await exists(join(root, 'templates/card.stator.d.ts'))).toBe(false)
    // Routes get no .d.ts.
    expect(await exists(join(root, '.stator/types/routes/index.stator.d.ts'))).toBe(false)

    const dts = await readFile(join(root, '.stator/types/templates/card.stator.d.ts'), 'utf8')
    expect(dts).toContain('(props: { title: string }) => HtmlFragment')
  })
})
