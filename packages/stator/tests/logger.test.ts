import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, logger, scopedLogger, setLogLevel } from '../src/server/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

// These would have caught the shipped-broken first cut: nothing exercised the
// level, so tsc + the suite passed while `stator start` still logged info.
describe('log level', () => {
  let savedEnv: string | undefined
  beforeEach(() => {
    savedEnv = process.env.LOG_LEVEL
    delete process.env.LOG_LEVEL
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = savedEnv
    setLogLevel('info')
  })

  it('setLogLevel reaches the root AND a scoped child created before the call', () => {
    const child = scopedLogger('before')
    setLogLevel('warn')
    expect(logger.level).toBe('warn')
    // The real bug: pino children keep their creation-time level, so a bare
    // `logger.level = 'warn'` would leave this scoped child at info.
    expect(child.level).toBe('warn')
  })

  it('setLogLevel reaches a scoped child created after the call', () => {
    setLogLevel('error')
    expect(scopedLogger('after').level).toBe('error')
  })

  it('createApp defaults to warn — the production entry is quiet by default', async () => {
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    expect(logger.level).toBe('warn')
  })

  it('createApp applies config logging.level', async () => {
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      logging: { level: 'error' },
    })
    expect(logger.level).toBe('error')
  })

  it('LOG_LEVEL env wins over config', async () => {
    process.env.LOG_LEVEL = 'debug'
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      logging: { level: 'error' },
    })
    expect(logger.level).toBe('debug')
  })
})
