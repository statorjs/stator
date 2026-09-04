---
"@statorjs/stator": minor
---

An app can no longer end up on in-memory session storage in production without saying so.

Every startup now states the persistence posture in its notice — printed at any log level, so a deploy log never leaves it to inference:

```
stator v2.10.0 · http://localhost:3000/ · 4 machines · 4 routes · sessions CachedStore
stator v2.10.0 · http://localhost:3000/ · 4 machines · 4 routes · sessions in-memory
```

In production, anything actually at risk also logs a warning: session machines on ephemeral storage, or `persist: true` app machines with no durable app store. An app with no session machines has nothing to lose here and is left alone, and nothing ever refuses to start — persistent storage is assumed to be what you want, never required.

**`sessionStore` and `appStore`** are the new way to pick a store from the environment, and they exist because the conditional every app was writing degrades in silence:

```ts
// before — correct in dev and CI, silently wrong in production
const store = url ? new CachedStore(new RedisStore(url)) : new InMemoryStore()

// after
persistence: { session: sessionStore({ redisUrl: process.env.REDIS_URL, cache: true }) }
```

Written in userland, the framework could not tell "deliberately in-memory" from "wanted Redis and the variable was empty". Written here it can, so the production warning names the variable — `REDIS_URL is empty, so session state is in memory and will not survive a restart` — instead of reporting a generic posture. A URL means Redis wherever it comes from, so pointing CI at a test Redis is just the variable being set; absent, empty and whitespace-only all mean in-memory. Passing the key is what declares the intent: `sessionStore()` with no arguments chooses in-memory deliberately and is never reported.

`stator build` also notes when a config declares no session store at all. That check is deliberately about the *shape* of the config and never about the value: whether a store is declared is knowable from the code, while which store a declared one resolves to depends on the production environment — which a build machine does not have, and should not. A build that errored on the store it resolved with CI's environment would fail every correctly configured deployment.

Enforcement — failing to start when a variable is missing — is not part of this. It belongs to declared environment variables, where one mechanism covers every required value rather than just this one.
