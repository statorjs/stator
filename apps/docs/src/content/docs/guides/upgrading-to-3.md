---
title: Upgrading to 3.0
description: "Every change a 2.x app has to make for Stator 3.0, in the order you'll meet them."
sidebar:
  order: 17
---

The changes below are ordered roughly as you'll hit them: install, typecheck, tests, then the running app. The [changelog](/changelog/) has the full list.

## Node 24

Stator 3.0 declares `engines: { node: ">=24" }`. `stator test` runs Node's own test runner and Stator loads TypeScript through Node's type stripping, so earlier versions don't work. Update `.node-version` or `.nvmrc`, your CI image and your production image together.

## Vite is gone

`stator dev` and `stator build` bundle islands with esbuild. Remove:

- `vite` from your dev dependencies;
- `STATOR_VITE_DEV` and `STATOR_ISLAND_BUNDLER` from scripts and CI;
- any import of `@statorjs/stator/vite`.

Stator never read a `vite.config.*`, so there's nothing in it to move. `createNativeDevApp` is removed (use `createDevApp`), as is `DevApp.vite`.

## `defineMachine` comes from `/machine`

```ts
// 2.x
import { defineMachine, sessionStore } from '@statorjs/stator/server'

// 3.0
import { defineMachine } from '@statorjs/stator/machine'
import { sessionStore } from '@statorjs/stator/server'
```

TypeScript reports each import you've missed as a missing export. The machine types (`MachineDef`, `DefineMachineConfig` and the rest) are still exported from both entries.

`@statorjs/stator/server` is server-only. A module in an island's bundle that imports it is refused by `stator dev`, `stator check` and `stator build`, with the module named.

## Plumbing imports come from `/server/runtime`

The deprecated re-exports of the Toolchain tier from `@statorjs/stator/server` are removed: `MachineStore`, `SessionRuntime`, `buildHonoApp`, `discoverMachines`, `renderRoute`, `recompute`, `fanOut` and the rest. Import them from `@statorjs/stator/server/runtime`, where they've lived since 2.12. Most apps never import these.

## Nested `createApp` options

The flat options deprecated in 2.2 are removed from `createApp` and `createDevApp`. Passing one throws and names its new home.

| 2.x | 3.0 |
|---|---|
| `store` | `persistence.session` |
| `appStore` | `persistence.app` |
| `sessionTtlSeconds` | `sessions.ttlSeconds` |
| `ssePingMs` | `realtime.pingMs` |
| `inspector` | `dev.inspector` |

Apps configured through `stator.config.ts` already use the nested shape.

## Tests run on `node:test`

`stator test` uses Node's built-in runner instead of Vitest, so remove `vitest` from your dependencies. Every `*.test.ts` and `*.spec.ts` under the app runs, each file in its own process.

| Vitest | 3.0 |
|---|---|
| `import { describe, it, expect, vi } from 'vitest'` | `import { describe, it, mock } from 'node:test'` and `import assert from 'node:assert/strict'` |
| `beforeAll` / `afterAll` | `before` / `after` |
| `expect(a).toBe(b)` | `assert.equal(a, b)` |
| `expect(a).toEqual(b)` | `assert.deepStrictEqual(a, b)` |
| `expect(a).toMatchObject(b)` | `assert.partialDeepStrictEqual(a, b)` |
| `expect(fn).toThrow()` | `assert.throws(fn)` |
| `vi.fn()` | `mock.fn()` |
| `vi.spyOn(o, 'm')` | `mock.method(o, 'm')` |
| `vi.useFakeTimers()` | `mock.timers.enable()` |
| `// @vitest-environment happy-dom` | `// @env happy-dom` |

Two things the table doesn't catch:

- Vitest's `toEqual` ignored keys whose value is `undefined`. `deepStrictEqual` doesn't, so an object with an extra `undefined` key now fails.
- A file's process ends only when nothing in it is still open. Close an app you called `listen()` on with `await app.close()` in `after()`, and the same for database handles and timers. The [testing guide](/guides/testing/) covers this.

Wire tests that set `STATOR_VITE_DEV=1` to boot the dev app in-process run without it.

## The event gate

`POST /__events` now accepts an event only when the page it comes from sends it. Stator reads what each page sends from source: `machine.send({ type })` in a template or fence, and `dispatch(Machine, { type })` in an island's script, across everything the route can render. Anything else gets a 403. An event type the machine's chart never handles gets a 400.

This closes a real hole. In 2.x a browser could post an effect's completion or a timer's event (a forged `CHARGE_OK`, for instance) unless the machine listed it `serverOnly`.

What to check:

- **Wire tests.** A test that posts to `/__events` must set `X-Stator-Route` to a page that sends that event. Posting `ADD` as the cart page when only the product page sends it is now a 403.
- **Computed event types.** A page that sends `{ type: kind }` can't be listed, so it accepts every event its machines handle, as before. `stator check` warns with the line.
- **Rolling it out.** `events: { gate: 'warn' }` in `stator.config.ts` logs what would be refused and accepts it. Run with that in staging, read the log, then remove it. `'off'` disables the check.

The gate isn't authorization. It's the same for every visitor, and guards still decide whether a visitor may commit an event their page offers.

## Middleware covers a page's events and live updates

Before an `/__events` or `/__sse` request touches a page, Stator runs your `middleware.ts` as if the browser had navigated to that page. A guard on `/members` therefore also turns away that page's events and stream. If your guard admits by HTTP method, note that it sees a `GET`. See [Middleware & security](/guides/middleware/).

## Smaller changes

- **`routes/404.stator` answers 404** without setting the status. A not-found page that relied on starting at 200 can still set `Stator.response.status`.
- **Dev serves per-route CSS.** Each route links its own stylesheet at the URL `stator build` uses. `/static/components.css` is no longer served, so a test that fetched it should follow the page's `<link rel="stylesheet">`.
- **Component libraries** don't need `.css` entries in their `exports`. A library that published CSS only that way should republish with `stator build:lib`, which writes per-component stylesheets beside the compiled modules. See [Component libraries](/guides/component-libraries/).
