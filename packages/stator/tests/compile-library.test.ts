import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compileLibrary } from '../src/build/compile-library.ts'
import { scopeHash } from '../src/compiler/hash.ts'

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

/**
 * Scope ids are qualified by the package name: two libraries with the same
 * file layout (`src/palette.stator` in each) must not share a `data-s-<hash>`,
 * or one library's scoped rules would silently apply to the other's markup.
 */
describe('build: compileLibrary scope ids', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
  })

  async function palette(name?: string): Promise<{ hashes: Set<string>; css: string }> {
    const r = await mkdtemp(join(tmpdir(), 'stator-lib-scope-'))
    roots.push(r)
    if (name) await writeFile(join(r, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await mkdir(join(r, 'src'), { recursive: true })
    await writeFile(
      join(r, 'src/palette.stator'),
      `<div class="palette">p</div>\n<style>.palette { color: red }</style>\n`,
    )
    await compileLibrary({ root: r, dir: join(r, 'src') })
    const ts = await readFile(join(r, 'src/palette.stator.ts'), 'utf8')
    const css = await readFile(join(r, 'src/palette.stator.css'), 'utf8')
    return { hashes: new Set([...ts.matchAll(/data-s-([0-9a-f]{8})/g)].map((m) => m[1]!)), css }
  }

  it('two packages with the same layout get different scope hashes', async () => {
    const a = await palette('@acme/blocks')
    const b = await palette('@other/blocks')
    expect(a.hashes.size).toBe(1)
    expect(b.hashes.size).toBe(1)
    const [ha] = a.hashes
    const [hb] = b.hashes
    expect(ha).not.toBe(hb)
    // Markup and stylesheet of one package agree with each other.
    expect(a.css).toContain(`data-s-${ha}`)
    expect(b.css).toContain(`data-s-${hb}`)
    expect(ha).toBe(scopeHash('@acme/blocks/src/palette.stator'))
  })

  it('a root with no package name falls back to the path-relative id', async () => {
    const { hashes } = await palette()
    expect([...hashes]).toEqual([scopeHash('src/palette.stator')])
  })
})
