import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Dev-native's `/static/components.css` includes a `node_modules` component
 * library's own CSS, resolved the same way production does (`externalCss`,
 * via the package's `exports` map) — not just locally authored `.stator`
 * files. This fixture imports the real `@statorjs/stator/components`, which
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

beforeAll(async () => {
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
}, 40_000)

afterAll(async () => {
  child?.kill()
  await rm(root, { recursive: true, force: true })
})

describe('native dev server: node_modules component CSS', () => {
  it('serves a node_modules component library CSS via components.css, resolved through its exports map', async () => {
    const res = await fetch(`${base}/static/components.css`)
    expect(res.status).toBe(200)
    const css = await res.text()
    expect(css).toContain('/* @statorjs/stator/components */')
    expect(css).toContain('max-width: 100%')
  })
})
