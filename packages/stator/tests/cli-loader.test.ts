import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const register = resolve(here, '../src/register.js')
const run = promisify(execFile)

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** The TS loader as `--import @statorjs/stator/register` and `stator start` install it. */
describe('the TS loader', () => {
  it('keeps a JSON import attribute through the transform', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stator-loader-'))
    await writeFile(join(dir, 'zips.json'), '[1, 2, 3]')
    await writeFile(
      join(dir, 'a.ts'),
      "import zips from './zips.json' with { type: 'json' }\nconst n: number = zips.length\nconsole.log('n=' + n)\n",
    )
    const { stdout } = await run(process.execPath, ['--import', register, join(dir, 'a.ts')])
    assert.equal(stdout.trim(), 'n=3')
  })
})
