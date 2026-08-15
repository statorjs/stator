---
"@statorjs/stator": minor
---

A `stator` CLI and a first-class `stator.config.ts`. The CLI (`stator dev/build/start/check/test`) replaces the hand-written `server.ts`/`build.ts`/`start.ts` an app used to wire itself; `stator build` now runs `stator check` first — a full server-stack typecheck, not just islands — so a broken server import fails the build instead of shipping silently. `defineConfig` in `stator.config.ts` carries what those entry files held, grouped by concern: `persistence` (the session and app stores), `sessions` (TTL), `realtime` (SSE heartbeat), `dev` (inspector), and `port` — every field optional, in-memory and port 3000 by default. Non-breaking: `createApp`/`createDevApp` still accept the previous flat options (`store`, `appStore`, `sessionTtlSeconds`, `ssePingMs`, `inspector`), now `@deprecated` in favor of the nested shape and slated for removal in a future major.
