import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createResource } from '../src/template/resource.ts'

describe('peekable resource', () => {
  it('fulfills a synchronous value immediately (defer degrades to inline render)', () => {
    const r = createResource(() => 42)
    assert.equal(r.status, 'fulfilled')
    assert.equal(r.value, 42)
  })

  it('a synchronous throw is a rejected resource, not an exception', () => {
    const err = new Error('boom')
    const r = createResource(() => {
      throw err
    })
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, err)
  })

  it('is pending until an async value settles, then fulfilled', async () => {
    const r = createResource(() => Promise.resolve('hi'))
    assert.equal(r.status, 'pending')
    assert.equal(r.value, undefined)
    await r.settled
    assert.equal(r.status, 'fulfilled')
    assert.equal(r.value, 'hi')
  })

  it('records a rejection as status=rejected + reason; settled resolves (never rejects)', async () => {
    const err = new Error('nope')
    const r = createResource(() => Promise.reject(err))
    // If settled rejected, this await would throw and fail the test.
    await r.settled
    assert.equal(r.status, 'rejected')
    assert.equal(r.reason, err)
  })

  it('a batch of resources can be awaited together, bounded by the slowest', async () => {
    const fast = createResource(() => Promise.resolve('a'))
    const slow = createResource(() => new Promise((res) => setTimeout(() => res('b'), 20)))
    const sync = createResource(() => 'c')
    await Promise.all([fast.settled, slow.settled, sync.settled])
    assert.deepStrictEqual([fast.value, slow.value, sync.value], ['a', 'b', 'c'])
  })
})
