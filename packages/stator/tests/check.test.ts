import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { checkStack } from '../src/cli/commands/check.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '.tmp-check-app')

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    skipLibCheck: true,
    types: [],
  },
  include: ['lib'],
})

async function scaffold(route: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'lib'), { recursive: true })
  await mkdir(join(root, 'routes'), { recursive: true })
  await writeFile(join(root, 'tsconfig.json'), tsconfig)
  await writeFile(join(root, 'lib/ok.ts'), 'export const ok = 1\n')
  await writeFile(join(root, 'routes/index.stator'), route)
}

afterEach(() => vi.restoreAllMocks())
afterAll(() => rm(root, { recursive: true, force: true }))

describe('stator check: the compiler runs over every .stator file', () => {
  it('a template the dev server would reject fails check, located', async () => {
    await scaffold(`---\nconst { x } = Stator.props<{ x: string }>()\n---\n<p>{x}</p>\n`)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(checkStack(root)).rejects.toThrow('typecheck failed with 1 error')
    const out = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('routes/index.stator:2:')
    expect(out).toContain('Stator.props() is not available in a route page')
    expect(out).toContain('^')
  })

  it('a sound app passes', async () => {
    await scaffold(`---\nconst title = 'hi'\n---\n<p>{title}</p>\n`)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await expect(checkStack(root)).resolves.toBeUndefined()
  })
})
