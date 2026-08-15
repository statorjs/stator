import { defineConfig } from '@statorjs/stator/config'
import { CachedStore, InMemoryStore, RedisStore, type Store } from '@statorjs/stator/server'

// Cache-in-front-of-Redis when REDIS_URL is set (write-through — a crash loses
// only the cache, not state); in-memory otherwise (does not survive restart).
const redisUrl = process.env.REDIS_URL
const store: Store = redisUrl
  ? new CachedStore(new RedisStore(redisUrl), { memoryTtlSeconds: 300, maxEntries: 10_000 })
  : new InMemoryStore()

export default defineConfig({
  persistence: { session: store },
  sessions: { ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400) },
})
