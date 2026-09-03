---
title: Production builds & deployment
description: "Compile once, serve with no Vite: stator build, the island manifest, and a Fly.io recipe."
sidebar:
  order: 14
---

Development and production run your app the same way — the difference is when compilation happens. `stator dev` compiles on import from your source tree; `stator build` compiles everything ahead of time, and `stator start` serves the result with no bundler in the process.

```bash
stator build    # compile the app to dist/ (runs `stator check` first)
stator start    # serve the built dist/ in production
```

A [`create-stator`](/introduction/installation/) project ships these as `pnpm build` / `pnpm start`.

The build:

1. copies `machines/`, `routes/`, `templates/`, `static/` into `dist/`,
2. compiles each `.stator` to a sibling `.ts` and rewrites imports,
3. concatenates scoped CSS into `dist/static/components.css`,
4. bundles every [client island](/guides/client-components/) through one bundler pass into hashed assets under `dist/static/assets/`, stubbing any server-machine imports down to `{ name }` so server code never reaches a browser bundle,
5. walks each route's import graph and writes `dist/stator-manifest.json` — which islands each route needs, plus the per-build id.

`stator start` loads that manifest to link `components.css` and inject each route's island scripts, and stamps the build id into live pages so the deploy-aware [reload handshake](/guides/realtime-sse/) can reload a page left on an older build. It runs your `stator.config.ts` exactly as dev does — same store, same session policy.

### A custom production entry (advanced)

Most apps never need this — `stator start` is the entry point. If you must hand-wire the server (an unusual host, an embedded runtime), the pieces are exported: `buildApp` and `loadProductionHead` from `@statorjs/stator/build`, and `createApp` from `@statorjs/stator/server`.

```ts
import { loadProductionHead } from '@statorjs/stator/build'
import { createApp } from '@statorjs/stator/server'

const { headExtras, buildId } = await loadProductionHead(dist)
const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  headExtras,
  buildId,
})
await app.listen(port)
```

## Deploy checklist

- **Always-on, single instance.** SSE connections need the process running — disable scale-to-zero, and don't scale out (fan-out and app machines are in-process; multi-replica is deferred).
- **Terminate TLS in front of the app.** Stator serves HTTP/1.1, where browsers allow roughly 6 connections per origin *across every tab in the profile* — enough live tabs and further requests to that origin queue. Any TLS-terminating proxy (Fly, Traefik, nginx, Cloudflare) makes the browser hop HTTP/2, where the live channels multiplex over one connection. Live pages also [release their channel](/guides/realtime-sse/) while their tab is hidden, which is what keeps the HTTP/1.1 case workable.
- **`REDIS_URL`** for session state that survives deploys (`RedisStore`, optionally wrapped in `CachedStore`), and `RedisAppStore` if you use [persisted app machines](/guides/app-machines/). Wire it in `stator.config.ts`'s `persistence`.
- **`NODE_ENV=production`** — JSON logs and the `Secure` cookie flag (override with `STATOR_SECURE_COOKIE=1|0` if TLS terminates elsewhere).
- **`SESSION_TTL_SECONDS`** — per-session idle expiry, default 24h.

These read from `process.env`, and Stator loads `.env` files into it at startup — `.env` for committed defaults, `.env.local` for machine-local secrets (gitignored). Precedence is **real environment → `.env.local` → `.env`**, so a value your host injects (a platform secret, a container env var) always wins over a file. In production, prefer real platform secrets for anything sensitive; `.env` is the convenience for local and simple deploys.

The repo's `apps/store` (the live demo) carries a working Fly.io + Upstash setup (`fly.toml`, `Dockerfile`): `fly launch --no-deploy --copy-config`, set `REDIS_URL` as a secret, `fly deploy`.
