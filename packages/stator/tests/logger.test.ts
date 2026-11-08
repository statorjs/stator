import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { createApp, logger, scopedLogger, setLogLevel } from '../src/server/index.ts'
import { loadPinoPretty } from '../src/server/logger.ts'

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
    assert.equal(logger.level, 'warn')
    // The real bug: pino children keep their creation-time level, so a bare
    // `logger.level = 'warn'` would leave this scoped child at info.
    assert.equal(child.level, 'warn')
  })

  it('setLogLevel reaches a scoped child created after the call', () => {
    setLogLevel('error')
    assert.equal(scopedLogger('after').level, 'error')
  })

  it('createApp defaults to warn — the production entry is quiet by default', async () => {
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
    })
    assert.equal(logger.level, 'warn')
  })

  it('createApp applies config logging.level', async () => {
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      logging: { level: 'error' },
    })
    assert.equal(logger.level, 'error')
  })

  it('LOG_LEVEL env wins over config', async () => {
    process.env.LOG_LEVEL = 'debug'
    await createApp({
      machinesDir: resolve(fixtures, 'machines'),
      routesDir: resolve(fixtures, 'routes'),
      logging: { level: 'error' },
    })
    assert.equal(logger.level, 'debug')
  })
})

describe('pino-pretty', () => {
  it('is loaded in-process from the framework, not resolved by pino as a transport', () => {
    assert.equal(typeof loadPinoPretty(), 'function')
  })

  it("is the dev logger's destination stream (no transport worker)", () => {
    const stream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym]
    assert.notEqual((stream as object).constructor.name, 'ThreadStream')
    assert.equal(typeof (stream as { write?: unknown }).write, 'function')
  })
})
