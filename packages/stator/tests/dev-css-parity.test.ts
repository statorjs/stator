import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/build/build.ts'

/**
 * Dev serves the stylesheet production serves. Each route links its own
 * sheet, at the same URL, holding exactly the components that route can
 * reach — never a component only another route uses — and dev's sheet is
 * byte-for-byte the one `stator build` writes.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/.tmp-dev-css-parity')
const outDir = join(root, 'dist')
const bin = resolve(here, '../src/cli/stator.js')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const component = (cls: string, color: string) =>
  `<p class="${cls}"><children /></p>\n<style>\n  .${cls} { color: ${color}; }\n</style>\n`
const route = (imports: string, body: string) =>
  `---\n${imports}\n---\n<html><head><title>t</title></head><body>${body}</body></html>\n`

let child: ChildProcess | undefined
let base = ''
const output: string[] = []

before(
  async () => {
    await rm(root, { recursive: true, force: true })
    await mkdir(join(root, 'routes'), { recursive: true })
    await mkdir(join(root, 'templates'), { recursive: true })
    await mkdir(join(root, 'machines'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n')
    await writeFile(join(root, 'templates/shared.stator'), component('shared', 'teal'))
    await writeFile(join(root, 'templates/only-home.stator'), component('home', 'red'))
    await writeFile(join(root, 'templates/only-about.stator'), component('about', 'blue'))
    await writeFile(join(root, 'templates/unused.stator'), component('unused', 'gray'))
    await writeFile(
      join(root, 'routes/index.stator'),
      route(
        "import Shared from '../templates/shared.stator'\nimport Home from '../templates/only-home.stator'",
        '<Shared>s</Shared><Home>h</Home>',
      ),
    )
    await writeFile(
      join(root, 'routes/about.stator'),
      route(
        "import Shared from '../templates/shared.stator'\nimport About from '../templates/only-about.stator'",
        '<Shared>s</Shared><About>a</About>',
      ),
    )
    await buildApp({ root, outDir })

    const port = 54000 + (process.pid % 3000)
    child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'info', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let bound = 0
    child.stdout?.on('data', (b) => {
      const s = String(b)
      output.push(s)
      const m = /localhost:(\d+)/.exec(s)
      if (m) bound = Number(m[1])
    })
    child.stderr?.on('data', (b) => output.push(String(b)))
    const deadline = Date.now() + 30_000
    while (!bound && Date.now() < deadline) await sleep(50)
    if (!bound) throw new Error(`dev server printed no banner:\n${output.join('')}`)
    base = `http://localhost:${bound}`
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/`)).status === 200) return
      } catch {
        // not listening yet
      }
      await sleep(50)
    }
    throw new Error(`dev server did not answer:\n${output.join('')}`)
  },
  { timeout: 60_000 },
)

after(async () => {
  child?.kill()
  await rm(root, { recursive: true, force: true })
})

/** The stylesheet a dev page links, and its body. */
async function devSheet(path: string): Promise<{ href: string; css: string }> {
  const html = await (await fetch(`${base}${path}`)).text()
  const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1]
  assert.ok(href, `${path} links a stylesheet`)
  const res = await fetch(`${base}${href}`)
  assert.equal(res.status, 200)
  return { href, css: await res.text() }
}

describe('dev CSS matches the production build', () => {
  for (const [path, file, own, other] of [
    ['/', 'index.stator', '.home[', '.about['],
    ['/about', 'about.stator', '.about[', '.home['],
  ] as const) {
    it(`${path} links the build's sheet at the build's URL, with the same bytes`, async () => {
      const { href, css } = await devSheet(path)
      assert.equal(href, `/static/css/routes/${file}.css`)
      const built = await readFile(join(outDir, 'static/css/routes', `${file}.css`), 'utf8')
      assert.equal(css, built)
    })

    it(`${path} carries only what it reaches`, async () => {
      const { css } = await devSheet(path)
      assert.ok(css.includes('.shared['), 'a shared component')
      assert.ok(css.includes(own), 'its own component')
      assert.ok(!css.includes(other), "not another route's component")
      assert.ok(!css.includes('.unused['), 'not a component nothing imports')
    })
  }

  it('no aggregate of every component is served', async () => {
    assert.equal((await fetch(`${base}/static/components.css`)).status, 404)
  })
})
