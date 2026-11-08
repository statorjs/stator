import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from 'hono'
import type { AnyMachineDef } from '../src/server/define-machine.ts'
import { MachineStore } from '../src/server/machine-store.ts'
import { getOrCreateSessionId } from '../src/server/session.ts'
import { InMemoryStore } from '../src/server/store.ts'

/** Minimal Hono-context stand-in that satisfies `hono/cookie` + the var map. */
function fakeContext(cookie?: string) {
  const vars = new Map<string, unknown>()
  const setCookies: string[] = []
  const headers = new Headers()
  if (cookie) headers.set('Cookie', cookie)
  const c = {
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
    req: { raw: { headers } },
    header: (n: string, v: string) => {
      if (n.toLowerCase() === 'set-cookie') setCookies.push(v)
    },
    setCookies,
  }
  return c as unknown as Context & { setCookies: string[] }
}

describe('establish-once session', () => {
  it('establishes once — repeat calls return the same new id and set one cookie', () => {
    const c = fakeContext()
    const first = getOrCreateSessionId(c)
    const second = getOrCreateSessionId(c) // e.g. middleware then a route handler
    assert.equal(first.isNew, true)
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(c.setCookies.length, 1) // NOT two — the double-create bug is closed
  })

  it('reads an existing cookie without re-issuing', () => {
    const c = fakeContext('stator_sid=abc-123')
    assert.deepStrictEqual(getOrCreateSessionId(c), { sessionId: 'abc-123', isNew: false })
    assert.equal(c.setCookies.length, 0)
  })
})

describe('reserved machine-name guard', () => {
  it('rejects a machine name using the reserved "__" prefix', () => {
    const def = { name: '__claims' } as AnyMachineDef
    assert.throws(() => new MachineStore([def], new InMemoryStore()), /reserved/)
  })
})
