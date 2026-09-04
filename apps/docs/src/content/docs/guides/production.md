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

1. copies what your code actually reaches into `dist/` (see [what gets copied](#what-gets-copied)),
2. compiles each `.stator` to a sibling `.ts` and rewrites imports,
3. concatenates scoped CSS into `dist/static/components.css`,
4. bundles every [client island](/guides/client-components/) through one bundler pass into hashed assets under `dist/static/assets/`, stubbing any server-machine imports down to `{ name }` so server code never reaches a browser bundle,
5. walks each route's import graph and writes `dist/stator-manifest.json` — which islands each route needs, plus the per-build id.

`stator start` loads that manifest to link `components.css` and inject each route's island scripts, and stamps the build id into live pages so the deploy-aware [reload handshake](/guides/realtime-sse/) can reload a page left on an older build. It runs your `stator.config.ts` exactly as dev does — same store, same session policy.

## What gets copied

`dist/` holds what your app reaches, worked out from the code rather than from a list of directory names. One pass walks the module graph from the entry points the framework itself loads — every file under `routes/` and `machines/`, plus a root-level `middleware.ts`, `boot.ts` and `stator.config.ts` — and everything reached from there comes along. `templates/` and `lib/` are copied because your routes import them, not because of what they're called, so renaming or adding a directory needs no configuration. `static/` always comes too, since the framework serves it by path.

Resolution is the bundler's own, so a tsconfig `paths` alias, an extensionless specifier or an `index.ts` behaves exactly as it does at runtime, and a `.stator` file's frontmatter imports are followed like any other import. Copying is per top-level directory, which is what lets a data file that nothing imports — a JSON fixture read with `readFile`, a template beside the module that reads it — ride along with its neighbours. A root-level file opened through `new URL('../app.db', import.meta.url)` is copied too.

The build prints what it decided, so nothing is a surprise:

```
stator build: 8 components → /srv/app/dist · 4 machines hashed in 4 ms
  copied: lib, machines, routes, static, templates · graph walked in 42 ms
  not copied: design, scripts — nothing in the app imports or opens them
```

A directory nothing reaches stays out. That is usually right — a `design/` folder of notes, a `scripts/` folder of maintenance tasks, an uploads directory your server writes at runtime — and it means runtime data never gets duplicated into a build artifact. If a directory *is* read at runtime through a path your code builds at runtime, name it:

```ts
export default defineConfig({
  build: { include: ['locales', 'data/seeds'] },
})
```

### Dynamic imports

A dynamic import is followed when the build can see where it goes:

```ts
await import('./reports/monthly.ts')        // string literal — followed
await import(`./locales/${lang}.ts`)        // fixed prefix — every match is included
await import(modulePath)                    // opaque — the build cannot know
```

The third form fails the build, naming the file and line. Nothing else can safely happen: the build has no way to know what that call loads, so a `dist/` built around it would be missing a module that only some request reaches — a production 500 rather than a build error. Make the specifier analysable, list what it reaches in `build.include`, or accept the risk with `build: { untracedImports: 'warn' }`.

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
- **`STATOR_SHUTDOWN_TIMEOUT_MS`** — how long a stop waits for in-flight requests, default 5000. Live connections are hung up immediately rather than waited on, so a `SIGTERM` exits in milliseconds instead of stalling until your platform's kill grace expires — see [stopping](/reference/cli/#stopping).

These read from `process.env`, and Stator loads `.env` files into it at startup — `.env` for committed defaults, `.env.local` for machine-local secrets (gitignored). Precedence is **real environment → `.env.local` → `.env`**, so a value your host injects (a platform secret, a container env var) always wins over a file. In production, prefer real platform secrets for anything sensitive; `.env` is the convenience for local and simple deploys.

The repo's `apps/store` (the live demo) carries a working Fly.io + Upstash setup (`fly.toml`, `Dockerfile`): `fly launch --no-deploy --copy-config`, set `REDIS_URL` as a secret, `fly deploy`.
