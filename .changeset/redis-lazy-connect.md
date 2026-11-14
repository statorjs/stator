---
"@statorjs/stator": patch
---

`RedisStore` and `RedisAppStore` connect on their first command instead of when they're constructed. An app's `stator.config.ts` builds its stores when it's loaded, so with `REDIS_URL` set, `stator build` (which loads the config but never uses a store) opened a Redis connection nothing closed and never exited. `close()` on a store that never connected now returns without contacting the server.
