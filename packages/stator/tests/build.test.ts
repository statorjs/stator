import { describe, it, expect, afterAll } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, rm, stat } from 'node:fs/promises'
import { buildApp } from '../src/build/build.ts'

/**
 * The production build: a `.stator` app → a `dist/` of plain `.ts` plus a
 * concatenated `components.css`, with no Vite. We assert the file outputs
 * (compiled siblings, rewritten specifiers, collected CSS); the end-to-end
 * "serve dist with createApp, no Vite" path is exercised manually against the
 * example app (it needs the app's own node_modules for module identity).
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/build-app')
const outDir = resolve(here, '.tmp-build-app-dist')

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('build: buildApp', () => {
  it('compiles .stator to sibling .ts, rewrites specifiers, and collects CSS', async () => {
    const result = await buildApp({ root, outDir })

    expect(result.compiled).toBe(1)
    expect(result.hasCss).toBe(true)

    // The .stator was compiled to a sibling .ts and the original removed.
    expect(await exists(join(outDir, 'templates/widget.stator.ts'))).toBe(true)
    expect(await exists(join(outDir, 'templates/widget.stator'))).toBe(false)

    // The compiled module is a real server module.
    const mod = await readFile(join(outDir, 'templates/widget.stator.ts'), 'utf8')
    expect(mod).toContain('export default function')
    expect(mod).toContain('html`')

    // The route's `.stator` import specifier was rewritten to `.stator.ts`.
    const route = await readFile(join(outDir, 'routes/index.ts'), 'utf8')
    expect(route).toContain("'../templates/widget.stator.ts'")
    expect(route).not.toContain("'../templates/widget.stator'")

    // Scoped CSS was concatenated to components.css.
    const css = await readFile(join(outDir, 'static/components.css'), 'utf8')
    expect(css).toMatch(/\.widget\[data-s-[0-9a-f]{8}\]/)
    expect(css).toContain('teal')
  })
})
