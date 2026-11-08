import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
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
    assert.equal(result.compiled, 3)
    assert.equal(result.islands, 0)
    assert.equal(result.entry, join(src, 'index.ts'))

    const card = await readFile(join(src, 'card.stator.ts'), 'utf8')
    assert.ok(card.includes("'./icon.stator.ts'"))
    assert.ok(!card.includes("'./icon.stator'"))
    assert.ok((await readFile(join(src, 'icon.stator.css'), 'utf8')).includes('.icon'))

    const css = await readFile(join(src, 'components.css'), 'utf8')
    assert.ok(css.includes('.card'))
    assert.ok(css.includes('.icon'))
    assert.ok(!css.includes('.orphan'))
    assert.ok(css.includes('/* src/card.stator */'))

    const again = await compileLibrary({ root: root!, dir: src })
    assert.equal(again.cssBytes, result.cssBytes)
    assert.equal(await readFile(join(src, 'components.css'), 'utf8'), css)
  })

  it('with no barrel, every component contributes', async () => {
    const src = await scaffold(false)
    const result = await compileLibrary({ root: root!, dir: src })
    assert.equal(result.entry, undefined)
    const css = await readFile(join(src, 'components.css'), 'utf8')
    assert.ok(css.includes('.card'))
    assert.ok(css.includes('.icon'))
    assert.ok(css.includes('.orphan'))
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
    assert.equal(a.hashes.size, 1)
    assert.equal(b.hashes.size, 1)
    const [ha] = a.hashes
    const [hb] = b.hashes
    assert.notEqual(ha, hb)
    // Markup and stylesheet of one package agree with each other.
    assert.ok(a.css.includes(`data-s-${ha}`))
    assert.ok(b.css.includes(`data-s-${hb}`))
    assert.equal(ha, scopeHash('@acme/blocks/src/palette.stator'))
  })

  it('a root with no package name falls back to the path-relative id', async () => {
    const { hashes } = await palette()
    assert.deepStrictEqual([...hashes], [scopeHash('src/palette.stator')])
  })
})
