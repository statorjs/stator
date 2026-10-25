import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileLibrary } from '../src/build/compile-library.ts'

/**
 * The publish-time compile for a component library: compiled siblings, the
 * `.stator` import rewrite, and a `components.css` holding exactly what the
 * barrel reaches.
 */

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function scaffold(withBarrel: boolean): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'stator-lib-'))
  const src = join(root, 'src')
  await mkdir(src, { recursive: true })
  await writeFile(
    join(src, 'card.stator'),
    `---\nimport Icon from './icon.stator'\n---\n<div class="card"><Icon /></div>\n<style>.card { color: red }</style>\n`,
  )
  await writeFile(
    join(src, 'icon.stator'),
    `<span class="icon">*</span>\n<style>.icon { color: blue }</style>\n`,
  )
  await writeFile(
    join(src, 'orphan.stator'),
    `<i class="orphan"></i>\n<style>.orphan { color: green }</style>\n`,
  )
  if (withBarrel) {
    await writeFile(join(src, 'index.ts'), `export { default as Card } from './card.stator.ts'\n`)
  }
  return src
}

describe('build: compileLibrary', () => {
  it('writes compiled siblings, rewrites .stator imports, aggregates what the barrel reaches', async () => {
    const src = await scaffold(true)
    const result = await compileLibrary({ root: root!, dir: src })
    expect(result.compiled).toBe(3)
    expect(result.islands).toBe(0)
    expect(result.entry).toBe(join(src, 'index.ts'))

    const card = await readFile(join(src, 'card.stator.ts'), 'utf8')
    expect(card).toContain("'./icon.stator.ts'")
    expect(card).not.toContain("'./icon.stator'")
    await expect(readFile(join(src, 'icon.stator.css'), 'utf8')).resolves.toContain('.icon')

    const css = await readFile(join(src, 'components.css'), 'utf8')
    expect(css).toContain('.card')
    expect(css).toContain('.icon')
    expect(css).not.toContain('.orphan')
    expect(css).toContain('/* src/card.stator.ts */')

    const again = await compileLibrary({ root: root!, dir: src })
    expect(again.cssBytes).toBe(result.cssBytes)
    expect(await readFile(join(src, 'components.css'), 'utf8')).toBe(css)
  })

  it('with no barrel, every component contributes', async () => {
    const src = await scaffold(false)
    const result = await compileLibrary({ root: root!, dir: src })
    expect(result.entry).toBeUndefined()
    const css = await readFile(join(src, 'components.css'), 'utf8')
    expect(css).toContain('.card')
    expect(css).toContain('.icon')
    expect(css).toContain('.orphan')
  })
})
