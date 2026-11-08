import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { stator } from '../src/vite/plugin.ts'

/**
 * Drives the `.stator` plugin through a real Vite dev server: one `.stator`
 * file routes to a server module + a scoped-CSS virtual, and the server module
 * imports the style virtual so the CSS is in the graph. Mirrors the build
 * spike's orchestration check, now against the real compiler.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/components')
const file = resolve(root, 'hello.stator')

let server: ViteDevServer | undefined
after(async () => {
  await server?.close()
})

describe('vite plugin: .stator', () => {
  it('routes a .stator file to a server module + scoped-CSS virtual', async () => {
    server = await createServer({
      root,
      plugins: [stator()],
      appType: 'custom',
      server: { middlewareMode: true },
      logLevel: 'error',
    })

    // Server module: lowered html`` + an import of the style virtual.
    const serverMod = await server.transformRequest(file)
    assert.ok(serverMod)
    assert.ok(serverMod!.code.includes('html`'))
    assert.ok(serverMod!.code.includes('section class="greeting"'))
    assert.ok(serverMod!.code.includes('stator&type=style'))

    // Style virtual: scoped CSS, transformed through Vite's CSS pipeline.
    const styleId = `${file}?stator&type=style&lang.css`
    const styleMod = await server.transformRequest(styleId)
    assert.ok(styleMod)
    // The selectors carry a data-s-<hash> attribute (scoped).
    assert.match(styleMod!.code, /data-s-[0-9a-f]{8}/)
    assert.ok(styleMod!.code.includes('greeting'))
  })

  it('serves a client component module at ?type=client (3b 6c)', async () => {
    server ??= await createServer({
      root,
      plugins: [stator()],
      appType: 'custom',
      server: { middlewareMode: true },
      logLevel: 'error',
    })
    const clientFile = resolve(root, 'toggle-box.stator')
    const mod = await server.transformRequest(`${clientFile}?stator&type=client`)
    assert.ok(mod)
    // The generated client entry: the StatorElement subclass + registration call.
    assert.ok(mod!.code.includes('class __ToggleBoxImpl'))
    assert.match(mod!.code, /defineElement\(__ToggleBoxImpl,\s*"toggle-box"\)/)
  })
})
