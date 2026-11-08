import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { after, afterEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
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

afterEach(() => mock.restoreAll())
after(() => rm(root, { recursive: true, force: true }))

describe('stator check: the compiler runs over every .stator file', () => {
  it('a template the dev server would reject fails check, located', async () => {
    await scaffold(`---\nconst { x } = Stator.props<{ x: string }>()\n---\n<p>{x}</p>\n`)
    const stderr = mock.method(process.stderr, 'write', () => true)

    await assert.rejects(checkStack(root), /typecheck failed with 1 error/)
    const out = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.ok(out.includes('routes/index.stator:2:'))
    assert.ok(out.includes('Stator.props() is not available in a route page'))
    assert.ok(out.includes('^'))
  })

  it('a sound app passes', async () => {
    await scaffold(`---\nconst title = 'hi'\n---\n<p>{title}</p>\n`)
    mock.method(process.stdout, 'write', () => true)
    assert.equal(await checkStack(root), undefined)
  })

  it('a raw() script string warns, located, and still passes', async () => {
    await scaffold(
      '---\nconst json = \'{}\'\n---\n<p>{raw(`<script type="speculationrules">${json}</script>`)}</p>\n',
    )
    const stderr = mock.method(process.stderr, 'write', () => true)
    const stdout = mock.method(process.stdout, 'write', () => true)

    assert.equal(await checkStack(root), undefined)
    const err = stderr.mock.calls.map((c) => String(c.arguments[0])).join('')
    assert.ok(err.includes('routes/index.stator:4:9 - warning: <script> built as a string'))
    assert.ok(
      stdout.mock.calls
        .map((c) => String(c.arguments[0]))
        .join('')
        .includes(', 1 warning\n'),
    )
  })
})
