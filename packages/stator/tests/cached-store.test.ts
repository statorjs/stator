import { describe, it, expect } from 'vitest'
import { CachedStore } from '../src/server/cached-store.ts'
import type { Store } from '../src/server/store.ts'

/**
 * Spy backing store: same surface as InMemoryStore but counts calls so
 * tests can assert "did the cache short-circuit?" or "did write-through
 * actually call the backing?".
 */
class SpyStore implements Store {
  getCalls = 0
  setCalls = 0
  hasCalls = 0
  deleteCalls = 0
  data = new Map<string, Map<string, unknown>>()

  async get(sid: string, name: string): Promise<unknown | null> {
    this.getCalls++
    return this.data.get(sid)?.get(name) ?? null
  }
  async set(sid: string, name: string, snapshot: unknown): Promise<void> {
    this.setCalls++
    let s = this.data.get(sid)
    if (!s) {
      s = new Map()
      this.data.set(sid, s)
    }
    s.set(name, snapshot)
  }
  async has(sid: string, name: string): Promise<boolean> {
    this.hasCalls++
    return this.data.get(sid)?.has(name) ?? false
  }
  async deleteSession(sid: string): Promise<void> {
    this.deleteCalls++
    this.data.delete(sid)
  }

  resetCounters(): void {
    this.getCalls = 0
    this.setCalls = 0
    this.hasCalls = 0
    this.deleteCalls = 0
  }
}

describe('CachedStore', () => {
  it('serves repeated reads from memory after the first backing fetch', async () => {
    const spy = new SpyStore()
    await spy.set('s1', 'M', { x: 1 })
    spy.resetCounters()

    const cache = new CachedStore(spy)
    expect(await cache.get('s1', 'M')).toEqual({ x: 1 })
    expect(await cache.get('s1', 'M')).toEqual({ x: 1 })
    expect(await cache.get('s1', 'M')).toEqual({ x: 1 })

    expect(spy.getCalls).toBe(1)
  })

  it('writes through to backing and primes the cache for subsequent reads', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy)

    await cache.set('s1', 'M', { x: 1 })

    // Backing got the write.
    expect(spy.setCalls).toBe(1)
    expect(spy.data.get('s1')?.get('M')).toEqual({ x: 1 })

    // Subsequent read is a cache hit — backing not consulted.
    spy.resetCounters()
    expect(await cache.get('s1', 'M')).toEqual({ x: 1 })
    expect(spy.getCalls).toBe(0)
  })

  it('deleteSession invalidates cache + forwards to backing', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy)
    await cache.set('s1', 'M', { x: 1 })
    await cache.set('s1', 'N', { y: 2 })
    await cache.set('s2', 'M', { z: 3 })

    await cache.deleteSession('s1')

    expect(spy.deleteCalls).toBe(1)
    expect(spy.data.has('s1')).toBe(false)

    // s1's cache entries are gone — reads fall through to (empty) backing.
    spy.resetCounters()
    expect(await cache.get('s1', 'M')).toBeNull()
    expect(spy.getCalls).toBe(1)

    // s2 still cached — read is a memory hit.
    spy.resetCounters()
    expect(await cache.get('s2', 'M')).toEqual({ z: 3 })
    expect(spy.getCalls).toBe(0)
  })

  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy, { maxEntries: 2 })

    await cache.set('s1', 'A', 1)
    await cache.set('s1', 'B', 2)
    await cache.set('s1', 'C', 3) // → evicts A

    // Read the survivor first — reading the evicted entry would populate it
    // back into the cache and disturb the LRU state we're verifying.
    spy.resetCounters()
    await cache.get('s1', 'B')
    expect(spy.getCalls).toBe(0) // hit — B still resident

    spy.resetCounters()
    await cache.get('s1', 'A')
    expect(spy.getCalls).toBe(1) // miss — A was evicted
  })

  it('LRU: a read bumps an entry to most-recent, sparing it from eviction', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy, { maxEntries: 2 })

    await cache.set('s1', 'A', 1) // order: [A]
    await cache.set('s1', 'B', 2) // order: [A, B]
    await cache.get('s1', 'A') //    order: [B, A]   (A bumped)
    await cache.set('s1', 'C', 3) // → evicts B, order: [A, C]

    // Read the survivor (A) first.
    spy.resetCounters()
    await cache.get('s1', 'A')
    expect(spy.getCalls).toBe(0) // A survived because of the bump

    spy.resetCounters()
    await cache.get('s1', 'B')
    expect(spy.getCalls).toBe(1) // B was evicted
  })

  it('expires entries after the memory TTL', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy, { memoryTtlSeconds: 0.05 }) // 50ms

    await cache.set('s1', 'M', 'value')

    spy.resetCounters()
    await cache.get('s1', 'M')
    expect(spy.getCalls).toBe(0) // immediate read is a hit

    await new Promise((r) => setTimeout(r, 80))

    spy.resetCounters()
    await cache.get('s1', 'M')
    expect(spy.getCalls).toBe(1) // post-TTL read is a miss
  })

  it('caps memory TTL at the per-set backing TTL when smaller', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy, { memoryTtlSeconds: 3600 }) // 1 hour memory

    // Backing TTL of 50ms — cache must not out-live it.
    await cache.set('s1', 'M', 'value', { ttlSeconds: 0.05 })

    await new Promise((r) => setTimeout(r, 80))

    spy.resetCounters()
    await cache.get('s1', 'M')
    expect(spy.getCalls).toBe(1) // memory entry expired even though memoryTtl is huge
  })

  it('tracks size accurately and stays at the cap', async () => {
    const spy = new SpyStore()
    const cache = new CachedStore(spy, { maxEntries: 3 })

    await cache.set('s', 'A', 1)
    await cache.set('s', 'B', 2)
    await cache.set('s', 'C', 3)
    expect(cache.size).toBe(3)

    await cache.set('s', 'D', 4)
    await cache.set('s', 'E', 5)
    expect(cache.size).toBe(3)
  })
})
