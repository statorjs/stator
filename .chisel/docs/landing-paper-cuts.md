# landing page — 3.0 beta punchlist

Found while rebuilding `apps/landing` as a Stator app on 3.0.0-next.5 (branch `feat/landing-stator`, 2026-11-10). The landing is the first app that is one cacheable page built almost entirely from client islands, so it leaned on parts of the island tier the other examples touch lightly.

Format: what happened → what it cost → what would help. Everything was observed against `stator build` + `stator start` unless noted; items marked *unverified* were not reproduced in isolation.

---

## Bugs

### 1. A portable `defineMachine` machine cannot run in an island, and nothing says so until runtime — FIX ON `fix/island-client-machines`

**Resolution (2026-11-10)**: what the island's script does with the import decides. The bundle gets the machine's code when the script passes it to `use()` (directly, through a `const` alias, or from a factory) or reads a value from the module, and the `{ name }` stub when it only dispatches to it. A use the build can't place, a barrel re-export, a server-pinned machine passed to `use()`, and server code taken from `@statorjs/stator/server` are build errors, reported by `stator dev` (overlay on save), `stator check` and `stator build`. `defineMachine` is exported only from `@statorjs/stator/machine`, so one definition runs on either side. The landing's hero island can go back to importing `lib/demo-cart.ts` once this merges.

The docs say a portable machine can be imported into an island `<script>` and run in the browser ([server/client boundary](../../apps/docs/src/content/docs/concepts/server-client-boundary.md), "The definition is location-agnostic"; state-machines, "portable … can run in a client island"). The island bundler stubs every module that imports `defineMachine` down to `{ name }` (`build/machines.ts` `isServerMachineModule`, used at `build/islands-esbuild.ts:116`), portable or not.

`lib/demo-cart.ts` (no reads, no persistence) imported into `round-trip.stator`'s `<script>` and passed to `use()`: `stator check` passed, `stator build` passed, and the page threw `TypeError: Cannot convert undefined or null to object` at `Object.keys(def.selectors)` in `client/use.ts`. *Unverified* in `stator dev`.

**Provenance**: new in 3.0.0-next.4 (`05efa99`, #232), and deliberate: its changeset says "An app island importing such a module outside `machines/` now gets the `{ name }` stub instead of the machine's code." Through 2.16 the stub applied only to files under `machines/`, so a portable machine in `lib/` bundled and ran in the browser. The change closed the only route by which a `defineMachine` machine could run client-side; the docs still describe that route. Read from the code at each tag, not reproduced on 2.16.

**Cost**: the hero island had to be rewritten on client `machine()`, with the cart's rules pulled into plain functions so two definitions could share them. **Would help**: one of
- make the stub decision follow portability, as the docs describe; or
- keep stubbing, and make `use(<stubbed machine>)` a compile error in `stator check`, and correct the two docs pages.

### 2. A top-level directory that only an island imports is not copied to `dist/` — FIXED ON `fix/beta-punchlist`

**Resolution**: the copy-set walk follows each island's `<script>` imports. A package only a script imports is still left out of the artifact's dependencies, since the island bundle holds it. The landing's `build.include: ['lib']` can go.

`stator build` derives the copy set from the server module graph (routes, machines, middleware, boot, config). `lib/cart-rules.ts` is imported only by an island `<script>`, so `lib/` was not copied, and the island bundle step then failed: `Could not resolve "../lib/cart-rules.ts"` from `templates/round-trip.stator.client.ts`.

**Provenance**: not a 3.0 change. It dates from the graph-derived copy set in 2.10 (`be57290`, #149); 2.16 already bundled islands from `dist/` with the same server-only walk.

**Cost**: a build failure whose message doesn't point at the cause. Worked around with `build.include: ['lib']` (`apps/landing/stator.config.ts`, marked TODO). **Would help**: include island `<script>` imports in the reachability walk, or bundle islands from the source tree.

### 3. `routes/404.stator` answers 200, and cacheably, unless the fence sets the status — FIXED ON `fix/beta-punchlist`

**Resolution**: a `404.stator`/`404.ts` page's response starts at 404; the fence can still set another status.

The routing guide says to set `Stator.response.status = 404`. Without that line the not-found page for every unknown URL went out as `200` with `Cache-Control: public, s-maxage=60, …`, since nothing in it withdraws the caching proof.

**Cost**: one forgotten line turns every bad URL into a cacheable soft-200. **Would help**: default the status to 404 for the `404.stator` sugar route, leaving an explicit status as the override.

### 4. The repo Dockerfile runs Node 22; 3.0 declares `engines.node >= 24` — FIXED ON `fix/beta-punchlist`

`Dockerfile:1` is `FROM node:22-slim`; `packages/stator/package.json` requires `>=24`. Whether the store deploy still boots on 22 was not tested. `apps/landing/Dockerfile` uses `node:24-slim`.

---

## Paper cuts

### 5. Island shells render client-machine reads as empty — OPEN, needs a design decision

In the server-rendered shell a client `read()` in text position is just its marker (`Cart (<!--s0-->)`), and one in attribute position is absent (`hidden={read(...)}` rendered no `hidden`). Until the island script runs, buttons had no labels and both branches of a show/hide pair were visible; with scripting off they stay that way.

**Cost**: on a cached page this is the first paint. The landing dropped `read()` in the hero island for static initial text plus one `effect()` that writes the DOM, and gave the theme button a fixed label. **Would help**: render a client read's initial value into the shell (the machine's initial context is known at shell render when the seed is static), or a documented fallback-content form.

### 6. Client `machine()` definitions can't be tested in Node — FIXED ON `fix/beta-punchlist`

**Resolution**: `@statorjs/stator/client` imports without a DOM; only constructing a `StatorElement` needs one, and says so.

`import('@statorjs/stator/client')` throws `HTMLElement is not defined`, so a `machine()` definition can't be handed to `createActor` in `stator test`. The "most of your tests need no DOM" story stops at the island boundary.

**Would help**: export `machine` from a module that doesn't load `StatorElement` (the engine subpath, or a `/client/machine` entry), so client machines test like server ones.

### 7. A context key named `events`, `on`, `select` or `name` fails `machine()` with an opaque overload error — FIXED ON `fix/beta-punchlist`

**Resolution**: the type error sits on the offending key and names it (`"events" is reserved in a machine() context: rename the key, or move behavior to the second argument`).

`machine({ state: 'idle', events: 0 }, { … })` reports "No overload matches this call … Type 'string' is not assignable to type 'never'" against every context key, because the context parameter is typed `C & { on?: never; select?: never; name?: never; events?: never }`. Renaming the key fixes it.

**Would help**: a targeted diagnostic naming the reserved key, in `stator check` or the language server.

### 8. `ClientInstance` exposes context and selectors but not the state value — FIXED ON `fix/beta-punchlist`

**Resolution**: the handle has `state`, typed to the machine's state names, unless the context or a selector is named `state`.

Only relevant if #1 goes the "allow portable machines" way: a `use()` handle on a multi-state machine has no public way to read the current state. The first draft reached for `instance.__actor.getSnapshot().value`, which is marked internal.

**Would help**: a `state` (or `matches()`) member on the instance, readable in `read()` selectors.

---

## Housekeeping

- **`netlify.toml`** still publishes `apps/landing` as a static folder. It has to change or go before `feat/landing-stator` merges.
- **`biome.jsonc`** still excludes `apps/landing`, which is now real code.
- **`apps/landing/static/og-image.png`** is the old design.
- **`pnpm create stator`** and the example starters need their own pass before 3.0 (already planned).
- **Docs code samples** that predate 3.0 conventions were not audited here; the old landing page had three (`expect()`-style tests, `export default class` islands, `Machine.dispatch()`).

## Parked design question

A session-scoped region on an otherwise cached page (a real server cart in the landing hero, a login-aware nav item). Today a route that declares any session-machine read establishes a session on GET and never gets the derived `Cache-Control` (`server/http.ts`, `needsSession`). Two shapes were discussed, a lazy session read on the route and a separately addressed region; both need a resync step for returning visitors. See [[lazy-session-establishment-and-cacheable-anonymous-reads]], whose open questions name the same gap. Not a 3.0 item.
