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
- **`stator build`** — compiles the app to `dist/` (plain TS, island assets bundled with esbuild, and a manifest). Runs `stator check` first, so a broken server import or bad prop fails the build instead of shipping. Prints which machines' sessions the build resets on deploy when it has a previous manifest to compare against, and says when it has none; `--previous <path>` names the last deployed `stator-manifest.json` for a pipeline that builds from a fresh checkout (see [Dev and build](/reference/dev-and-build/#buildapp)).
- **`stator start`** — serves a built `dist/` in production. Reads the same `stator.config.ts` as `dev`; no bundler or compiler runs in the process.
- **`stator check [dir]`** — typechecks the whole stack: regenerates the per-component `.stator.d.ts` declarations and the virtual TSX the editor checks, compiles every `.stator` file with the real compiler (the same call `dev` makes on import and the editor makes per edit, so a template the dev server would reject fails here too), checks the contract stamp of every library component the routes reach, then runs `tsc` over the nearest `tsconfig.json`. An island is checked twice over: its `<script>`, and the compiled client module with the wiring the compiler generates for its template, so `on:click={save}` fails when `save` can't take the event. Errors in generated code are reported at the `.stator` line they came from. `dir` narrows the `.stator` files checked, for a component library: `stator check src`. The generated files land under the root's `.stator/` either way, and the contract check walks `<dir>/routes` when it exists (`--routes <dir>` overrides it) and is skipped with a note when it doesn't. The single "is my app sound?" gate — no output, just a pass/fail.
- **`stator test`** — runs every `*.test.ts` and `*.spec.ts` in the app with Node's built-in test runner (`node --test`), with Stator's TypeScript loader registered, so packages built on Stator load from `node_modules`, however deep. Each file runs in its own process; a file with a `// @env happy-dom` line gets browser globals (happy-dom as a dev dependency). Framework logging defaults to `silent`; export `LOG_LEVEL` to bring logs back while debugging. Arguments pass through: file paths to run only those, or Node's flags (`--watch`, `--test-name-pattern`). See [Testing](/guides/testing/#running-the-suite).
- **`stator build:lib [dir]`** — compiles a component library for publishing: every `.stator` under `dir` (default `src`) to its sibling `.stator.ts` and `.css`, and one stylesheet aggregated for the package's `./components.css` export from the directory's `index.ts` barrel. Runs `stator check dir` first, so a component with a type error is never compiled for publishing. Wire it into `prepublishOnly`. See [Component libraries](/guides/component-libraries/).

## Flags

- **`--root <dir>`** — app root. Default: the current directory.
- **`--port <n>`** — listen port for `dev`/`start`. Precedence: `--port` > `$PORT` > `stator.config.ts` `port` > 3000.
- **`--routes <dir>`** — `check`, `build:lib`: the routes the contract check walks from. Default: `<dir>/routes`, or the root's `routes/`.
- **`-h`, `--help`** — usage.

## Stopping

`SIGINT` (Ctrl+C) and `SIGTERM` (a deploy rollover, `systemctl stop`, a container stop) drain the server and exit `0` — a signal is a normal stop, not a failure. The drain, in order: stop accepting connections, run the [`boot.ts`](/recipes/startup-and-background-work/) teardown so no source can raise another event, hang up every [live connection](/guides/realtime-sse/), then wait for in-flight requests.

Live connections are **hung up, not waited for**. An SSE response is one request that lasts as long as the page is open, so waiting for every connection to end would mean waiting forever — the process would hang until the platform lost patience and killed it. Dropping a live channel is cheap by design: the browser reconnects and re-syncs from the server's baseline, or reloads if it comes back to a newer build.

**`STATOR_SHUTDOWN_TIMEOUT_MS`** bounds what's left — real request work — and defaults to `5000`. When it expires, remaining sockets are destroyed and the process exits anyway, with a warning naming the deadline. Keep it under your platform's own kill grace (`docker stop` allows 10s; Kubernetes' `terminationGracePeriodSeconds` and systemd's `TimeoutStopSec` are usually longer). A second signal exits immediately without draining.

For a hand-wired entry (an unusual host, an embedded runtime), the CLI's underlying functions — `createApp`, `createDevApp`, `buildApp` — are exported; see [server](/reference/server/) and [dev & build](/reference/dev-and-build/).
