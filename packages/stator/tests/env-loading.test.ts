import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createApp } from '../src/server/create-app.ts'
import { loadDotenv } from '../src/server/env.ts'

/**
 * `.env` loading precedence: real shell env > .env.local > .env. The loader
 * uses native `process.loadEnvFile` (never overrides an already-set key) and
 * loads `.env.local` before `.env` to get that ordering.
 */

let dir: string
const touched: string[] = []
const set = (k: string, v: string) => {
  touched.push(k)
  process.env[k] = v
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stator-env-'))
})
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k]
  rmSync(dir, { recursive: true, force: true })
})

describe('loadDotenv', () => {
  it('loads .env into process.env', () => {
    writeFileSync(join(dir, '.env'), 'ENV_ONE=alpha\nENV_TWO=beta\n')
    loadDotenv(dir)
    touched.push('ENV_ONE', 'ENV_TWO')
    assert.equal(process.env.ENV_ONE, 'alpha')
    assert.equal(process.env.ENV_TWO, 'beta')
  })

  it('.env.local wins over .env; .env fills the gaps', () => {
    writeFileSync(join(dir, '.env'), 'SHARED=from_env\nONLY_ENV=e\n')
    writeFileSync(join(dir, '.env.local'), 'SHARED=from_local\nONLY_LOCAL=l\n')
    loadDotenv(dir)
    touched.push('SHARED', 'ONLY_ENV', 'ONLY_LOCAL')
    assert.equal(process.env.SHARED, 'from_local') // local overrides
    assert.equal(process.env.ONLY_ENV, 'e') // .env still fills what local omits
    assert.equal(process.env.ONLY_LOCAL, 'l')
  })

  it('real shell env wins over both files', () => {
    set('SHARED', 'from_shell')
    writeFileSync(join(dir, '.env'), 'SHARED=from_env\n')
    writeFileSync(join(dir, '.env.local'), 'SHARED=from_local\n')
    loadDotenv(dir)
    assert.equal(process.env.SHARED, 'from_shell')
  })

  it('is a no-op when no files exist (no throw)', () => {
    assert.doesNotThrow(() => loadDotenv(dir))
  })

  it('loads .env.local even when .env is absent', () => {
    writeFileSync(join(dir, '.env.local'), 'LOCAL_ONLY=x\n')
    loadDotenv(dir)
    touched.push('LOCAL_ONLY')
    assert.equal(process.env.LOCAL_ONLY, 'x')
  })
})

describe('createApp root', () => {
  it('reads .env from `root` and resolves relative dirs against it, wherever the process started', async () => {
    writeFileSync(join(dir, '.env'), 'FROM_APP_ROOT=yes\n')
    mkdirSync(join(dir, 'machines'))
    mkdirSync(join(dir, 'routes'))
    touched.push('FROM_APP_ROOT')
    // The test process's cwd is the package, not `dir` — the old behaviour
    // would have looked for .env there and found nothing.
    const app = await createApp({ root: dir, machinesDir: 'machines', routesDir: 'routes' })
    assert.equal(process.env.FROM_APP_ROOT, 'yes')
    const res = await app.fetch(new Request('http://localhost/nothing-here'))
    assert.equal(res.status, 404)
  })
})
