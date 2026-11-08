---
"@statorjs/stator": major
---

The flat `createApp` and `createDevApp` options deprecated in 2.2 are removed. Use the nested shape that `stator.config.ts` already has: `store` → `persistence.session`, `appStore` → `persistence.app`, `sessionTtlSeconds` → `sessions.ttlSeconds`, `ssePingMs` → `realtime.pingMs`, `inspector` → `dev.inspector`. Passing a removed key throws with its new home rather than being ignored. Apps configured through `stator.config.ts` are unaffected.
