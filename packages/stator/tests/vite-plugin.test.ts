import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
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
afterAll(async () => {
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
    expect(serverMod).toBeTruthy()
    expect(serverMod!.code).toContain('html`')
    expect(serverMod!.code).toContain('section class="greeting"')
    expect(serverMod!.code).toContain('stator&type=style')

    // Style virtual: scoped CSS, transformed through Vite's CSS pipeline.
    const styleId = `${file}?stator&type=style&lang.css`
    const styleMod = await server.transformRequest(styleId)
    expect(styleMod).toBeTruthy()
    // The selectors carry a data-s-<hash> attribute (scoped).
    expect(styleMod!.code).toMatch(/data-s-[0-9a-f]{8}/)
    expect(styleMod!.code).toContain('greeting')
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
    expect(mod).toBeTruthy()
    // The generated client entry: the StatorElement subclass + registration call.
    expect(mod!.code).toContain('class __ToggleBoxImpl')
    expect(mod!.code).toMatch(/defineElement\(__ToggleBoxImpl,\s*"toggle-box"\)/)
  })
})
