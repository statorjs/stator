import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    expect(process.env.ENV_ONE).toBe('alpha')
    expect(process.env.ENV_TWO).toBe('beta')
  })

  it('.env.local wins over .env; .env fills the gaps', () => {
    writeFileSync(join(dir, '.env'), 'SHARED=from_env\nONLY_ENV=e\n')
    writeFileSync(join(dir, '.env.local'), 'SHARED=from_local\nONLY_LOCAL=l\n')
    loadDotenv(dir)
    touched.push('SHARED', 'ONLY_ENV', 'ONLY_LOCAL')
    expect(process.env.SHARED).toBe('from_local') // local overrides
    expect(process.env.ONLY_ENV).toBe('e') // .env still fills what local omits
    expect(process.env.ONLY_LOCAL).toBe('l')
  })

  it('real shell env wins over both files', () => {
    set('SHARED', 'from_shell')
    writeFileSync(join(dir, '.env'), 'SHARED=from_env\n')
    writeFileSync(join(dir, '.env.local'), 'SHARED=from_local\n')
    loadDotenv(dir)
    expect(process.env.SHARED).toBe('from_shell')
  })

  it('is a no-op when no files exist (no throw)', () => {
    expect(() => loadDotenv(dir)).not.toThrow()
  })

  it('loads .env.local even when .env is absent', () => {
    writeFileSync(join(dir, '.env.local'), 'LOCAL_ONLY=x\n')
    loadDotenv(dir)
    touched.push('LOCAL_ONLY')
    expect(process.env.LOCAL_ONLY).toBe('x')
  })
})
