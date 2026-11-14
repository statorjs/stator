import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { logSid } from '../src/server/logger.ts'

describe('logSid', () => {
  it('logs a short stable hash, never the id itself', () => {
    const sid = crypto.randomUUID()
    const shown = logSid(sid)
    assert.match(shown, /^#[0-9a-f]{12}$/)
    assert.ok(!shown.includes(sid.slice(0, 8)))
    assert.equal(logSid(sid), shown)
    assert.notEqual(logSid(crypto.randomUUID()), shown)
  })

  it("passes the framework's own scopes through", () => {
    assert.equal(logSid('@app'), '@app')
    assert.equal(logSid('@anonymous'), '@anonymous')
  })
})
