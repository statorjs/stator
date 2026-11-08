import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { RedisAppStore, RedisStore } from '../src/server/redis-store.ts'

/**
 * Real-Redis integration tests. In CI, the workflow's Redis service container
 * provides REDIS_URL; locally they skip unless one is exported. The point is
 * exercising the actual ioredis pipeline (HSET+EXPIRE, JSON round-trips,
 * corrupted-entry recovery) — a mock's fidelity is the thing under test.
 */
const REDIS_URL = process.env.REDIS_URL

describe('RedisStore (session)', { skip: !REDIS_URL }, () => {
  const prefix = `stator-test:${process.pid}:${Math.random().toString(36).slice(2, 8)}`
  const store = new RedisStore(REDIS_URL ?? '', prefix)

  after(async () => {
    await store.raw.del(`${prefix}:s1`)
    await store.close()
  })

  it('round-trips snapshots and reports has()', async () => {
    assert.equal(await store.get('s1', 'CartMachine'), null)
    assert.equal(await store.has('s1', 'CartMachine'), false)

    const snapshot = { value: ['idle'], context: { items: [{ id: 'p1', qty: 2 }] } }
    await store.set('s1', 'CartMachine', snapshot)
    assert.deepStrictEqual(await store.get('s1', 'CartMachine'), snapshot)
    assert.equal(await store.has('s1', 'CartMachine'), true)
  })

  it('applies the per-session TTL on set and refreshes it', async () => {
    await store.set('s1', 'CartMachine', { value: ['idle'], context: {} }, { ttlSeconds: 120 })
    const ttl = await store.raw.ttl(`${prefix}:s1`)
    assert.ok(ttl > 60)
    assert.ok(ttl <= 120)

    // A later write with a bigger TTL refreshes the WHOLE session hash.
    await store.set('s1', 'OtherMachine', { value: ['x'], context: {} }, { ttlSeconds: 600 })
    assert.ok((await store.raw.ttl(`${prefix}:s1`)) > 120)
  })

  it('treats corrupted entries as missing instead of crashing', async () => {
    await store.raw.hset(`${prefix}:s1`, 'BrokenMachine', '{not json')
    assert.equal(await store.get('s1', 'BrokenMachine'), null)
  })

  it('deleteSession removes the whole hash', async () => {
    await store.set('s1', 'CartMachine', { value: ['idle'], context: {} })
    await store.deleteSession('s1')
    assert.equal(await store.has('s1', 'CartMachine'), false)
  })
})

describe('RedisAppStore (app)', { skip: !REDIS_URL }, () => {
  const prefix = `stator-test-app:${process.pid}:${Math.random().toString(36).slice(2, 8)}`
  const store = new RedisAppStore(REDIS_URL ?? '', prefix)

  after(async () => {
    await store.close()
  })

  it('round-trips app snapshots with no TTL', async () => {
    assert.equal(await store.loadAppMachine('BoardMachine'), null)
    const snapshot = { value: ['ready'], context: { total: 42 } }
    await store.saveAppMachine('BoardMachine', snapshot)
    assert.deepStrictEqual(await store.loadAppMachine('BoardMachine'), snapshot)
  })

  it('treats corrupted blobs as missing', async () => {
    const raw = new RedisStore(REDIS_URL ?? '', 'unused')
    await raw.raw.set(`${prefix}:CorruptMachine`, 'not-json{')
    assert.equal(await store.loadAppMachine('CorruptMachine'), null)
    await raw.raw.del(`${prefix}:CorruptMachine`, `${prefix}:BoardMachine`)
    await raw.close()
  })
})
