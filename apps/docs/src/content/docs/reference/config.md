---
title: "stator.config.ts"
description: "defineConfig and every option: persistence, sessions, realtime, security, dev, and the app secret."
sidebar:
  order: 1
---

A `stator.config.ts` at the app root configures the `stator` CLI (and `createApp`/`createDevApp`). It's **optional** — with no config file an app runs on in-memory state, port 3000, dev inspector on. Export a `defineConfig(...)` default:

```ts
import { defineConfig } from '@statorjs/stator/config'
import { RedisStore } from '@statorjs/stator/server'

export default defineConfig({
  persistence: { session: new RedisStore(process.env.REDIS_URL!) },
  sessions: { ttlSeconds: 86_400 },
  secret: process.env.STATOR_SECRET,
})
```

Every field is optional and grouped by concern. `.env` / `.env.local` are loaded before the config runs, so `process.env` is available here.

## Options

```ts
interface StatorConfig {
  port?: number       // dev/start listen port. Precedence: --port flag > $PORT > this > 3000
  host?: string       // bind address. Default: all interfaces (containers often want 0.0.0.0)
  origin?: string     // canonical app URL (https://example.com) — absolute-URL generation + same-origin anchor
  secret?: string     // signing key for signed cookies. Falls back to STATOR_SECRET

  persistence?: {
    session?: Store   // session-machine state. Default: InMemoryStore (restart-wipe)
    app?: AppStore    // app-machine state for `persist: true` machines. Default: in-memory
  }

  sessions?: {
    ttlSeconds?: number                    // per-session idle expiry. Default: 86400 (24h)
    cookie?: { sameSite?: 'Lax' | 'Strict' } // Default: Lax. Strict → allowlist-only cross-site posture
  }

  realtime?: {
    pingMs?: number   // SSE heartbeat interval. Default: 25000
  }

  dev?: {
    inspector?: boolean // dev inspector toolbar. Default: on in dev
  }

  images?: {
    dir: string          // originals directory (runtime data, NOT static/); mounts the endpoint
    path?: string        // URL prefix; default '/' + basename(dir)
    widths?: number[]    // ?w= allowlist + default srcset widths; default [400, 800, 1200, 1600]
    aspectRatios?: number[]  // ?h= crop aspects (w/h); default square, 4:3, 3:2, 16:9 + portrait duals
    transformer?: ImageTransformer  // swap sharp for another implementation
    concurrency?: number // max parallel encodes across ALL requests. Default: 2
    threads?: number     // libvips worker threads per encode. Default: sharp's (= reported cores)
    encodeTimeoutMs?: number // per-request encode deadline; past it → 302 to the original. Default: 15000; 0 disables
    maxAge?: number      // Cache-Control freshness lifetime (seconds). Default: 0 (revalidate every use)
    staleWhileRevalidate?: number // serve-stale window (seconds); heals on the NEXT view. Default: 0
    immutable?: boolean  // append `immutable` to a nonzero maxAge — write-once URLs only
  }
  logging?: {
    level?: 'silent' | 'error' | 'warn' | 'info' | 'debug' // Default: warn (prod) / info (dev). LOG_LEVEL env wins
  }

  trustedOrigins?: string[] // origins allowed to make cross-site writes past the CSRF guard (exact or *.wildcard)
  cors?: { origins?: string[]; credentials?: boolean } // cross-origin READ policy; origins defaults to trustedOrigins
}
```

## Notes

- **Persistence is grouped by concern.** `persistence.session` and `persistence.app` are the two swappable [store adapters](/guides/persistence/); the other bags hold policy, not adapters. See `RedisStore`/`CachedStore`/`RedisAppStore` in the [server reference](/reference/server/).
- **Secrets belong in the environment.** Prefer `process.env.STATOR_SECRET` and a `REDIS_URL` over hard-coding — `.env.local` (gitignored) for local, real platform secrets in production. See [Production](/guides/production/).
- **Security options** (`trustedOrigins`, `sessions.cookie.sameSite`) pair with the [middleware guide](/guides/middleware/); CORS is opt-in per route/app via the `cors()` middleware.
- **`createApp`/`createDevApp`** accept this same shape directly (plus dir options) for hand-wired entries — see [dev & build](/reference/dev-and-build/). The pre-2.2 flat keys (`store`, `sessionTtlSeconds`, …) are deprecated in favor of the nested shape here.
- **Image caching is a dial, not a switch.** The default (`maxAge: 0`) makes every use revalidate against a content-hash ETag — a cheap `304` per image per view, and a replaced image is visible immediately. `staleWhileRevalidate` is the usual upgrade: repeat views render instantly from cache while the browser revalidates in the background, so a changed image heals on the *next* view. `immutable` is for apps whose upload path generates a fresh URL for every file — once an immutable response is cached there is no server-side recovery, so treat enabling it as a promise. SVG serves as an original only (never resized or transcoded) with script-neutralizing security headers.
- **Small hosts need the encode knobs.** sharp sizes its thread pool from the *reported* core count — on shared-cpu machines that's the physical host's, and one large AVIF encode can swamp a fractional vCPU. On a small machine set `concurrency: 1` and `threads: 1`; `encodeTimeoutMs` (default 15s) then guarantees no visitor waits on a pathological encode — the request serves the stored original while the variant finishes in the background. If AVIF encoding still dominates, pass `formats={['webp']}` to `<Picture>` and the endpoint never encodes AVIF at all.
