import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// A tool that loads stator.config.ts (`stator build`) builds its stores
// without using them; the process must still be able to exit.
const storeModule = join(dirname(fileURLToPath(import.meta.url)), '../src/server/store-intent.ts')

describe('Redis stores that are never used', () => {
  it('open no connection, so the process exits on its own', () => {
    const script = `
      const { appStore, sessionStore } = await import(${JSON.stringify(storeModule)})
      sessionStore({ redisUrl: 'redis://127.0.0.1:9' })
      sessionStore({ redisUrl: 'redis://127.0.0.1:9', cache: true })
      appStore({ redisUrl: 'redis://127.0.0.1:9' })
    `
    const r = spawnSync(
      process.execPath,
      ['--import', '@statorjs/stator/register', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10_000 },
    )
    assert.equal(r.signal, null, `the process was still running after 10s\n${r.stderr}`)
    assert.equal(r.status, 0, r.stderr)
  })

  it('close without connecting', async () => {
    const { RedisAppStore, RedisStore } = await import('../src/server/redis-store.ts')
    await new RedisStore('redis://127.0.0.1:9').close()
    await new RedisAppStore('redis://127.0.0.1:9').close()
  })
})
