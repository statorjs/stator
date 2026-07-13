---
title: Production builds & deployment
description: "Compile once, serve with no Vite: buildApp, the island manifest, and a Fly.io recipe."
sidebar:
  order: 14
---

Dev runs through Vite (`createDevApp`); production doesn't. `buildApp`
compiles everything ahead of time, and the plain runtime serves the result:

```ts
// build.ts
import { buildApp } from '@statorjs/stator/build'

await buildApp({ root: here, outDir: resolve(here, 'dist') })
```

The build:

1. copies `machines/`, `routes/`, `templates/`, `static/` into `dist/`,
2. compiles each `.stator` to a sibling `.ts` and rewrites imports,
3. concatenates scoped CSS into `dist/static/components.css`,
4. bundles every [client island](/guides/client-components/) through one Vite
   pass into hashed assets under `dist/static/assets/`, stubbing any
   server-machine imports down to `{ name }` so server code never reaches a
   browser bundle,
5. walks each route's import graph and writes `dist/stator-manifest.json` —
   which islands each route needs.

## Serving the build

```ts
// start.ts
import { loadProductionHead } from '@statorjs/stator/build'
import { createApp } from '@statorjs/stator/server'

const app = await createApp({
  machinesDir: resolve(dist, 'machines'),
  routesDir: resolve(dist, 'routes'),
  staticDir: resolve(dist, 'static'),
  headExtras: await loadProductionHead(dist),
})
await app.listen(port)
```

`loadProductionHead` links `components.css` and injects each route's island
`<script type="module">` tags from the manifest. No Vite in the process —
`tsx start.ts` is the whole server.

A [`create-stator`](/introduction/installation/) project ships this wiring as
`pnpm build` / `pnpm start`.

## Deploy checklist

- **Always-on, single instance.** SSE connections need the process running —
  disable scale-to-zero, and don't scale out (fan-out and app machines are
  in-process; multi-replica is 1.x).
- **`REDIS_URL`** for session state that survives deploys (`RedisStore`,
  optionally wrapped in `CachedStore`), and `RedisAppStore` if you use
  [persisted app machines](/guides/app-machines/).
- **`NODE_ENV=production`** — JSON logs and the `Secure` cookie flag
  (override with `STATOR_SECURE_COOKIE=1|0` if TLS terminates elsewhere).
- **`SESSION_TTL_SECONDS`** — per-session idle expiry, default 24h.

The repo's `apps/store` (the live demo) carries a working Fly.io + Upstash setup
(`fly.toml`, `Dockerfile`): `fly launch --no-deploy --copy-config`, set
`REDIS_URL` as a secret, `fly deploy`.
