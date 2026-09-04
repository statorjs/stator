---
title: "stator CLI"
description: "The stator command: dev, build, start, check, test — and the flags they share."
sidebar:
  order: 2
---

The `stator` CLI is the entry point for a Stator app — it replaces the hand-written `server.ts`/`build.ts`/`start.ts` earlier versions needed. A [`create-stator`](/introduction/installation/) project wires these as `package.json` scripts:

```json
{
  "scripts": {
    "dev": "stator dev",
    "build": "stator build",
    "start": "stator start",
    "check": "stator check",
    "test": "stator test"
  }
}
```

All commands discover `machines/`, `routes/`, `templates/`, `static/` by convention and read an optional [`stator.config.ts`](/reference/config/).

## Commands

- **`stator dev`** — the development server: live reload, the wire inspector, compile-error overlays, and `.stator` compilation on import. Your app runs natively from its source tree, exactly as `stator start` runs a build — no bundler in the server path. Serves on `port` (default 3000), shifting up if it's taken.
- **`stator build`** — compiles the app to `dist/` (plain TS + bundled island assets + a manifest), with **no Vite in the output**. Runs `stator check` first, so a broken server import or bad prop fails the build instead of shipping.
- **`stator start`** — serves a built `dist/` in production. Reads the same `stator.config.ts` as `dev`; no Vite in the process.
- **`stator check`** — typechecks the whole stack: regenerates the per-component `.stator.d.ts` declarations, then runs `tsc` over the server. The single "is my app sound?" gate — no output, just a pass/fail. Replaces the old `sync.ts` + `tsc` step.
- **`stator test`** — runs the test suite.

## Flags

- **`--root <dir>`** — app root. Default: the current directory.
- **`--port <n>`** — listen port for `dev`/`start`. Precedence: `--port` > `$PORT` > `stator.config.ts` `port` > 3000.
- **`-h`, `--help`** — usage.

## Stopping

`SIGINT` (Ctrl+C) and `SIGTERM` (a deploy rollover, `systemctl stop`, a container stop) drain the server and exit `0` — a signal is a normal stop, not a failure. The drain, in order: stop accepting connections, run the [`boot.ts`](/recipes/startup-and-background-work/) teardown so no source can raise another event, hang up every [live connection](/guides/realtime-sse/), then wait for in-flight requests.

Live connections are **hung up, not waited for**. An SSE response is one request that lasts as long as the page is open, so waiting for every connection to end would mean waiting forever — the process would hang until the platform lost patience and killed it. Dropping a live channel is cheap by design: the browser reconnects and re-syncs from the server's baseline, or reloads if it comes back to a newer build.

**`STATOR_SHUTDOWN_TIMEOUT_MS`** bounds what's left — real request work — and defaults to `5000`. When it expires, remaining sockets are destroyed and the process exits anyway, with a warning naming the deadline. Keep it under your platform's own kill grace (`docker stop` allows 10s; Kubernetes' `terminationGracePeriodSeconds` and systemd's `TimeoutStopSec` are usually longer). A second signal exits immediately without draining.

For a hand-wired entry (an unusual host, an embedded runtime), the CLI's underlying functions — `createApp`, `createDevApp`, `buildApp` — are exported; see [server](/reference/server/) and [dev & build](/reference/dev-and-build/).
