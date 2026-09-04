import { defineConfig } from '@statorjs/stator/config'
import { sessionStore } from '@statorjs/stator/server'

export default defineConfig({
  // Redis when REDIS_URL is set, in-memory otherwise — so dev and CI need no
  // Redis, and production says so out loud if the variable is missing rather
  // than quietly losing every session on restart. Cache-in-front-of-Redis is
  // write-through: a crash loses the cache, not the state.
  persistence: {
    session: sessionStore({
      redisUrl: process.env.REDIS_URL,
      cache: { memoryTtlSeconds: 300, maxEntries: 10_000 },
    }),
  },
  sessions: { ttlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 86400) },
})
