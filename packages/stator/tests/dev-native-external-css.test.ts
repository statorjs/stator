import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * A dev route's stylesheet includes a package component's own CSS when the
 * route reaches it, the same way production does: the walk crosses the bare
 * specifier into the package and reads each reached component's sibling
 * `.css` by path — not just locally authored `.stator` files. This fixture imports the real `@statorjs/stator/components`, which
 * resolves through this package's own self-referencing `node_modules`
 * symlink the same way any external consumer resolves it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/.tmp-dev-ext-css-app')
const bin = resolve(here, '../src/cli/stator.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let child: ChildProcess | undefined
let base = ''
const output: string[] = []

before(
  async () => {
    await rm(root, { recursive: true, force: true })
    await mkdir(resolve(root, 'routes'), { recursive: true })
    await mkdir(resolve(root, 'machines'), { recursive: true })
    await writeFile(
      resolve(root, 'routes/index.ts'),
      "import { defineRoute } from '@statorjs/stator/server'\n" +
        "import { html } from '@statorjs/stator/template'\n" +
        "import { Image } from '@statorjs/stator/components'\n\n" +
        'export const GET = defineRoute({\n' +
        '  reads: [],\n' +
        '  render: () =>\n' +
        "    html`<html><head><title>ext-css</title></head><body>${Image({ src: '/x.jpg', width: 10, height: 10, alt: 'x' })}</body></html>`,\n" +
        '})\n',
    )

    const port = 53000 + (process.pid % 3000)
    child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'info', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let bound = 0
    child.stdout!.on('data', (b) => {
      const s = String(b)
      output.push(s)
      const m = /localhost:(\d+)/.exec(s)
      if (m) bound = Number(m[1])
    })
    child.stderr!.on('data', (b) => output.push(String(b)))

    const deadline = Date.now() + 30_000
    while (!bound && Date.now() < deadline) await sleep(50)
    if (!bound) throw new Error(`native dev server printed no banner:\n${output.join('')}`)
    base = `http://localhost:${bound}`
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/`)).status === 200) return
      } catch {
        // not listening yet
      }
      await sleep(50)
    }
    throw new Error(`native dev server did not answer:\n${output.join('')}`)
  },
  { timeout: 40_000 },
)

after(async () => {
  child?.kill()
  await rm(root, { recursive: true, force: true })
})

describe('native dev server: node_modules component CSS', () => {
  it("serves a package component's sibling CSS in the route's sheet, labelled by package path", async () => {
    const html = await (await fetch(`${base}/`)).text()
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1]
    assert.equal(href, '/static/css/routes/index.css')
    const res = await fetch(`${base}${href}`)
    assert.equal(res.status, 200)
    const css = await res.text()
    assert.ok(css.includes('/* @statorjs/stator/src/components/image.stator */'))
    assert.ok(css.includes('max-width: 100%'))
  })
})
