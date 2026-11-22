import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * `stator dev` applies `events` from `stator.config.ts`. The fixture's config
 * sets `gate: 'off'` and `maxBytes: 256`; its one page reads the counter and
 * offers no event, so the default gate would refuse `BUMP`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, 'fixtures/dev-events-config')
const bin = resolve(here, '../src/cli/stator.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('stator dev: events config', () => {
  let child: ChildProcess | undefined
  let bound = 0

  before(async () => {
    const port = 57000 + (process.pid % 2000)
    child = spawn(process.execPath, [bin, 'dev', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: 'warn', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (b) => {
      const m = /localhost:(\d+)/.exec(String(b))
      if (m) bound = Number(m[1])
    })
    for (let i = 0; i < 100 && !bound; i++) await sleep(100)
    assert.ok(bound > 0, 'dev server bound a port')
  })
  after(() => void child?.kill('SIGKILL'))

  const send = (event: object): Promise<Response> =>
    fetch(`http://localhost:${bound}/__events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stator-Route': 'GET /',
        Origin: `http://localhost:${bound}`,
      },
      body: JSON.stringify({ machine: 'CounterMachine', event }),
    })

  it('events.gate "off" accepts an event the page does not offer', async () => {
    assert.equal((await send({ type: 'BUMP' })).status, 200)
  })

  it('events.maxBytes caps the event body', async () => {
    const res = await send({ type: 'BUMP', pad: 'x'.repeat(1000) })
    assert.equal(res.status, 413)
    assert.deepEqual(await res.json(), { error: 'event body exceeds 256 bytes' })
  })
})
