# @statorjs/stator

## 2.7.0

### Minor Changes

- 774d51c: The dev inspector now inspects machines, not just wire traffic. The toolbar gets a **Machines** tab in a master-detail layout: a nav listing every machine with its live state inline — your session's machines first, then app-lifecycle machines under a "process-global" heading, then the route table with each route's `reads` — and a detail pane with the selected machine's context and the events its current state accepts (server-only and guarded ones marked). When a persisted snapshot was written by different machine code, a `stale` chip shows the session will start fresh on its next request — the snapshot hydration policy made visible instead of inferred from logs. The drawer's top edge is now draggable, and its height, open state, active tab, and selected machine all persist across the dev loop's reloads. The tab is a navigable graph, not two lists: a route's `reads` chips jump to that machine's detail, a machine's detail names the machines it reads and the routes that read it ("read by"), and static GET routes render as real links — click `/cart` in the toolbar and you're on `/cart`.

  Behind the tab are two additive pieces of public surface. `describeMachine(def)` (exported via `@statorjs/stator/machine`) serializes a machine def to plain JSON-able data — states, per-event transition candidates (`to`/guard/action/emits/effect), entry effects and `after` timers, machine-level fallbacks, `serverOnly`, emits, selectors, reads, subscribes — with closures reported as presence, never bodies. And `GET /@stator/inspect` serves the catalog plus snapshots, scoped to the caller's own session cookie by construction.

  The endpoint is served by the dev servers only. Production never registers it — including when a site opts into the wire toolbar with `dev.inspector: true` — because machine context is working state and may hold anything; the tab degrades to a notice there. The endpoint is read-only: no actors are instantiated, no session lock is taken, nothing dispatches. A session machine you've never touched reads as `null` and the tab shows the def's initial context, dimmed — truthfully "what a fresh instance would start from," not fake state.

## 2.6.0

### Minor Changes

- f1f8482: `meta.session` on effects. For session machines, every effect — entry and transition — now receives the session it runs for: `meta.session.id` and `meta.session.claims<T>()`, the same app-defined claims middleware reads with `stator(c).claims()`. It is what lets an entry effect reload a durable fact by identity on a fresh start, after TTL expiry, or after a snapshot reset — `loadCart(meta.session.claims<Me>().userId)` — with no client round trip. App machines have no session and client islands run no host, so `meta.session` is `undefined` there. The engine stays session-unaware: `EffectInvocation.run(signal, session?)` merges whatever the host passes.
- f1f8482: `stator dev` now runs your app natively — the same way production runs it. The dev server no longer embeds Vite: `.stator` files compile on import in Node's module loader, your app runs from its **source tree** (so `import.meta.url`-relative paths — a SQLite file, a data dir — mean the same thing in dev as in prod), and islands bundle behind the same seam the production build uses, served from memory on the production URLs with the production `<head>` shape. The dev/prod divergence class this closes is structural: there is no second module graph for a file to load twice into, no transform that runs in dev and vanishes in prod.

  The loop got faster and more precise with it. An edit re-evaluates exactly the changed modules and their importers — a `lib/db.ts` that opens a connection at top level runs once per session, not once per edit — and a failed rebuild keeps the last good build serving while the compile error (code frame included) shows in an overlay. Live reload arrives over a small SSE channel instead of Vite's HMR socket.

  Fixed alongside: both dev servers recreated the default in-memory session store on every machine-touching rebuild, silently resetting **all** sessions even when no machine's code changed. The store now lives as long as the dev process, so the snapshot hydration policy does what it promises in dev: only the machines whose code actually changed start fresh, everything else carries over — cart contents and all.

  Transitional surface: `STATOR_VITE_DEV=1` keeps the previous Vite-embedded dev server for one minor as an escape hatch (if something forces you onto it, please open an issue). `DevApp.vite` is deprecated — `undefined` on the native server with a one-time warning, removed in the next major. App code, config, and the CLI surface are unchanged.

- f1f8482: Sessions never outlive the code that made them. Every persisted machine snapshot is now stamped with a hash of the machine's code — the machine file plus every module it reaches, tree-shaken — and hydration discards a snapshot whose hash no longer matches the running machine, starting that machine fresh (logged once per machine, then at 10, 100, …). A renamed state can no longer strand a session in a state the chart doesn't have, and a session can no longer keep running under guards it wasn't created under. The rule is identical in development and production and for every Store.

  **This release resets all persisted machine state once**, because existing snapshots carry no hash. From here on, a machine's sessions reset only when that machine's code changes, and `stator build` prints which machines each deploy resets (`machine code changed — sessions reset on deploy for: …`). Machine state is working state with a TTL, not persistence: anything whose loss would be an incident belongs in your own store, written by an effect and reloaded by an entry effect — see the persistence guide.

  Mechanics: `stator build` hashes every machine in one esbuild pass and fails the build if a machine's closure can't be bundled (so an import problem surfaces in CI, not at a production boot); the hashes ship in `stator-manifest.json` and `stator start` consumes them. `createApp` accepts `machineHashes` (`loadProductionHead(dist).machines`); without it, machines are hashed live at boot, as the dev servers do. `Snapshot` gains optional `format` and `code` fields; `BuildResult` gains `machines`, `machineHashMs`, `resetMachines`. `persist: true` app machines follow the same rule: they survive restarts while their code is unchanged.

### Patch Changes

- ff3067d: Stack traces and island debugging now resolve to source. The `stator` CLI opts the process into Node's sourcemap application (the runtime equivalent of `--enable-source-maps`) — the inline maps the loader pipeline already emitted now actually reach server stack traces, in `stator dev` and `stator start` alike. TS frames resolve exactly; a `.stator` frame resolves to the compiled server module (right file, generated lines). And the dev server bundles islands with inline sourcemaps, so browser devtools show your island source instead of bundled output — production bundles still ship unmapped (`sourcemap` is a dev-only option on the `bundleIslands` seam).

## 2.5.1

### Patch Changes

- 9f5b9fe: Fix a dev/prod divergence: the dev server no longer reads a user `vite.config.*`. Production (`stator build`) already ignored it (`configFile: false`), so a Vite plugin configured there would run under `stator dev` and then silently vanish from the build — an app that "worked" in dev but shipped broken. `stator dev` now sets `configFile: false` too, matching production; Stator's own plugins are unaffected (they're applied inline). Nothing in the framework, examples, or docs relied on the config being read.

## 2.5.0

### Minor Changes

- fe14c65: `boot.ts` — run code once when the server starts. A root-level `boot.ts` (auto-discovered like `middleware.ts`) is the home for a long-lived inbound source: query config at startup, then start a poll or subscription that feeds events into the app-machine graph.

  ```ts
  // boot.ts
  import { defineBoot } from "@statorjs/stator/server";
  import FleetMachine from "./machines/fleet.ts";

  export default defineBoot(async ({ dispatchToApp }) => {
    const timer = setInterval(
      async () =>
        dispatchToApp(FleetMachine, { type: "TICK", data: await poll() }),
      30_000
    );
    return () => clearInterval(timer); // teardown, composed into graceful shutdown
  });
  ```

  - Runs **once per process** when the app starts listening (a dev restart re-runs it; an in-process rebuild does not; tests that only `app.fetch` never trigger it).
  - **`BootContext` is deliberately narrow** — `dispatchToApp` (feed the app-machine graph) and a read-only `config`. Not the raw app: no `listen`/`fetch`/`hono`/store, because boot is a _source_, not a controller. Env stays ambient (`process.env` is loaded before boot runs).
  - Return a **teardown** to clean up on shutdown (clear a timer, unsubscribe a source).

  Cadence _policy_ belongs in the machine (a guard can debounce a `TICK` by state — unit-testable with `createActor`), not in the boot closure.

- 1a55a96: Deploy-aware reload — a live page from a stale build reloads itself. The server now stamps a build identifier into every live page (`<meta name="stator-build">`) — per-boot in dev, per-build in production (written to the build manifest). The client echoes it on the `/__sse` connection, and if the server is now serving a different build, it tells the page to hard-reload instead of resyncing onto a slot map that may no longer match.

  This closes two gaps:

  - **Dev:** a `tsx`-side server restart previously fired no browser reload, so a changed DOM↔slot-ID contract could silently break patches. Now the restart is a new build-id → the client reloads on reconnect.
  - **Prod:** after a deploy, still-open pages reconnect to the new build and reload, rather than applying patches against the old layout.

  Per-build (not per-boot) in production, so a crash-restart of the _same_ build doesn't reload everyone — only an actual deploy does. Fully graceful: an app with no build-id (a build predating this, or a hand-written server that doesn't set one) simply keeps today's resync-never-reload behavior.

### Patch Changes

- 1a55a96: Fix: `stator start` now passes the config `secret` through to the running app. Previously the production server only picked up the signing secret from `STATOR_SECRET` in the environment — a `secret` set in `stator.config.ts` was silently dropped in production (it worked in dev via `createDevApp`). Signed cookies configured with an explicit `secret` now work under `stator start` too.

## 2.4.0

### Minor Changes

- ae602ac: `.env` file loading. Stator now loads `.env` files into `process.env` at startup, so server config and secrets (a store URL, an auth provider secret, `LOG_LEVEL`, `PORT`) have a uniform home across dev and prod — no more relying on the shell to export them, and no `import.meta.env` (which is Vite-transform-time and absent in production).

  Precedence, highest first: **real shell env → `.env.local` → `.env`**. Commit `.env` for defaults; keep machine-local secrets in `.env.local` (gitignored). A real environment variable always wins, so production secrets injected by the host are never shadowed by a stray file.

  Loaded by `createApp`/`createDevApp` (covering a hand-written `server.ts`) and by the `stator` CLI _before_ it imports `stator.config.ts` (so your config file can read `process.env.*`). Uses Node's native `process.loadEnvFile` — no new dependency. Absent files are skipped.

  Scaffold templates now gitignore `.env.local` / `.env*.local`.

- cef2bd1: Signed cookies — the sealed short-lived-state primitive. The cookie jar (`stator(c).cookies` / `ctx.cookies`) gains `setSigned`/`getSigned`, adding a tamper-evident signature over a cookie value using an app secret:

  ```ts
  await cookies.setSigned("oauth_state", state, {
    httpOnly: true,
    maxAge: 600,
  });
  const state = await cookies.getSigned("oauth_state"); // string | undefined
  ```

  This is the substrate for auth flows that hand short-lived state to the browser and must trust it on the way back without server-side storage: the OAuth `state`/PKCE handshake, a magic-link token, a WebAuthn challenge.

  - **Secret:** new top-level `secret` in config, falling back to `process.env.STATOR_SECRET` (loadable via `.env`). Use a long random string, kept out of source.
  - **`getSigned` returns `undefined`** for a missing _or_ invalid signature — a tampered value, or one signed with a since-rotated secret, is never trusted (no `false` to handle, no leak of the distinction).
  - **No secret configured → a clear throw** at call time (not a silent weak signature).
  - Signing is tamper-_evidence_, not encryption — the value stays client-readable, so seal a nonce, not a secret. Server-stored state keyed by an opaque cookie id remains the env-free alternative.

  Continues the 2.3 session-identity thread (auth primitives, part 2). Bundles into 2.4.0 with `.env` loading.

## 2.3.0

### Minor Changes

- e216ab1: Cross-site (CSRF) write protection is now composable and config-tunable. The guard Stator already applied — `Sec-Fetch-Site`/`Origin` on state-changing requests — is exported as `crossSiteGuard()` and applied ahead of route matching, so a cross-site write to an unknown path returns 403 rather than revealing the route with a 404. Two config knobs, both data (no behavior toggles):

  - `trustedOrigins` — origins allowed to make cross-site writes despite the guard, exact (`https://app.example.com`) or wildcard-subdomain (`https://*.example.com`). Matching is boundary-safe: `https://*.example.com` matches `app.example.com` and `a.b.example.com`, never `example.com.evil.com` or the apex.
  - `sessions.cookie.sameSite: 'Strict'` — the controlled posture. Sets the session cookie `SameSite=Strict` (withheld from every cross-site request) and flips the guard to allowlist-only for same-site writes too, so `trustedOrigins` becomes the whole gate.

  Non-breaking: with no config the behavior is exactly as before (same-origin/same-site allowed, cross-site blocked).

- 4a060b8: HTTP middleware and a security-primitive toolkit. Add a `middleware.ts` at your app root — `export default defineMiddleware([...])` — for cross-cutting request logic (auth guards, CORS, headers). The framework's security defaults run first, then your handlers, then the route, so a guard here can't be missed by a route added later; with no `middleware.ts` the defaults still apply (safe by default). `dangerouslyDefineMiddleware([...])` opts out of the defaults — a deliberate, greppable _code_ act, never a config flag, and it skips only the security defaults, never framework plumbing.

  New exported middleware primitives:

  - `cors()` — cross-origin _read_ policy (distinct from `trustedOrigins`, which governs cross-site _writes_); reflects an allowed `Origin` for credentialed reads and answers preflight. `cors.origins` defaults to `trustedOrigins`.
  - `securityHeaders()` — opt-in baseline headers (`nosniff` always; frame/referrer with safe defaults; HSTS/CSP opt-in).
  - `crossSiteGuard()` — the default write guard, exported so a `dangerously…` app can re-add it.

  Middleware read resolved config off the request via `stator(c)`. New config data: `origin` (canonical URL), `host` (bind address), and `cors`. `createApp`/`createDevApp` also expose the raw Hono app as `.hono` for break-glass extension.

- 1a3daa1: `serverOnly` event declaration — seal the events no client should ever send. A machine can now list event types that are server-generated only (effect completions like `CHARGE_APPROVED`, `after:` timers, cross-machine internals):

  ```ts
  defineMachine({
    name: "CartMachine",
    events: {} as Events,
    serverOnly: ["CHARGE_APPROVED", "CHARGE_DECLINED"],
    // ...
  });
  ```

  A client `POST /__events` of a server-only event is rejected with **403** at the wire boundary, before dispatch — closing the forged-completion hazard (a `CHARGE_APPROVED` that fakes a settled charge). The list is typechecked against the machine's event union, so a name that isn't a real event is a compile error.

  The completion still reaches the machine normally: an effect returning `{ type: 'CHARGE_APPROVED' }` re-enters through the internal dispatch path, which never touches `/__events`. The gate blocks only the forgeable client wire path.

  Enforced in **dev and prod alike** — the declaration is explicit, so there's no false-positive risk and no dev/prod divergence (a UI that accidentally dispatches a server-only event fails the same 403 locally). This is a coarse origin gate ("could a client ever send this"), not per-user authorization — machine guards still own that.

  The reference storefront's cart uses it on its charge completions; the new [Server-only events](https://stator.dev/recipes/server-only-events/) recipe walks the pattern (including the nonce-guard for completions that cross a trust boundary inside the server).

- 481220b: Session identity primitives — the machine-unaware layer a third-party auth toolkit builds on. Stator ships the primitives, not an auth system: what a claim contains and whether it's still valid stays the app's job.

  - **Session claims** — opaque per-session identity/data, readable from middleware (which runs upstream of the machine pipeline and cannot read a machine). `stator(c).claims()/setClaims()/clearClaims()` in middleware; the same three on the API-route handler `ctx`. Claims persist per session at a reserved `__claims` key; machine names may no longer start with the reserved `__` prefix. This is the projection a coarse edge-admission check needs — a redirect at the door — while your machines stay the source of truth.
  - **Session lifecycle ops** — `rotateSession()` (fixation defense on privilege change: state moves to a fresh id) and `clearSession()` (delete the session, browser goes anonymous). Immediate in middleware (`await stator(c).rotateSession()`), deferred on the handler `ctx` (applied after the handler returns, so state persists before the id changes). Claims set the same request follow the rotation to the new id.
  - **Cookie jar** — `stator(c).cookies` and handler `ctx.cookies`: `get`/`set`/`delete` over app-owned cookies (a login `returnTo`, a consent flag), distinct from the framework-managed session cookie. Thin over the platform; `get` reads the inbound request cookie.

  The session is now established once per request and shared across middleware and handlers (one `sid`, one claims snapshot) — closing a latent double-issue on a request's first sight. A no-JS form POST that rotates the session or sets a cookie no longer drops the `Set-Cookie` on the empty-directive 204 path.

  Non-breaking: apps that set no claims and touch no session ops are unaffected. The `with-auth` example gains a layered demonstration — coarse admission in middleware off the claims projection, fine-grained authorization still in the machine chart and in-route guards.

## 2.2.0

### Minor Changes

- 7fe66d7: Log-level control and a quieter production default. `createApp` (the production entry) now defaults to `warn` — errors and warnings only — while the dev server stays at `info`; the per-request HTTP lines and per-connection SSE lines that used to log at `info` are now `debug`, so a production server no longer narrates every request and connection. The one-line startup notice (`stator vX · http://localhost:PORT/ · N machines · N routes`) now prints independent of the log level, so a quiet `warn` server still confirms it booted. Set the level in `stator.config.ts` via `logging.level` (`'silent' | 'error' | 'warn' | 'info' | 'debug' | …`), or override anywhere with the `LOG_LEVEL` env (precedence: `LOG_LEVEL` > `logging.level` > default).
- 0259433: A `stator` CLI and a first-class `stator.config.ts`. The CLI (`stator dev/build/start/check/test`) replaces the hand-written `server.ts`/`build.ts`/`start.ts` an app used to wire itself; `stator build` now runs `stator check` first — a full server-stack typecheck, not just islands — so a broken server import fails the build instead of shipping silently. `defineConfig` in `stator.config.ts` carries what those entry files held, grouped by concern: `persistence` (the session and app stores), `sessions` (TTL), `realtime` (SSE heartbeat), `dev` (inspector), and `port` — every field optional, in-memory and port 3000 by default. Non-breaking: `createApp`/`createDevApp` still accept the previous flat options (`store`, `appStore`, `sessionTtlSeconds`, `ssePingMs`, `inspector`), now `@deprecated` in favor of the nested shape and slated for removal in a future major.

## 2.1.0

### Minor Changes

- 424ea40: Island files may now carry a frontmatter fence. It runs server-side, per shell render — exactly a server component's contract — and its bindings are in scope for the template; the `<script>` never sees it, in either direction. Fences are for server work the island owns (imports, computed constants, queries); per-use data stays props. `Stator.*` markers are rejected in island fences with located errors, and a fence binding sharing a name with a `use()` field is a located error rather than a precedence rule.

## 2.0.2

### Patch Changes

- a568762: An island file's frontmatter was silently discarded — the shell either crashed at first render with a dangling identifier (fence bindings referenced in the template) or carried a fence that never executed. It is now a located compile error explaining the model: an island's shell renders from props, so server work belongs in the route or component that renders the island.

## 2.0.1

### Patch Changes

- cd06c4e: `defineMachine`'s state union is inferred from the `states` map's keys alone — every interior `S` position (`to:` targets, the machine-level `on:` map) is now `NoInfer`. Previously `to:` string literals were competing inference candidates, so whenever the transition graph didn't happen to target every state the union silently collapsed to the covered subset: valid definitions failed to typecheck (`initial` rejected, selector maps degraded to their default) as soon as duplicated per-state handlers moved to machine-level `on:`. Surfaced by the store's cart machine; regression-pinned in the machine-level `on:` tests.
- cd06c4e: `<time datetime={…}>` typechecks — the per-element attribute set was missing `time`'s `datetime`, so microformats `dt-published` markup was a compile error.

## 2.0.0

### Major Changes

- 7adbfa8: `bind:` and the engine's `@set` event are removed. Display is `read()`, everywhere — `{read(m, (s) => s.value)}` in text position, `attr={read(m, …)}` in attribute position, on server and client machines alike — and every state change is a declared, typed event through `on:`. The directive surface is now `on:` (events in) + `ref:` (identity). For form drafts, the input owns its text: platform constraints guard the draft, a typed event commits it (`ref:`/`FormData` at the boundary), and pre-fill is a server-rendered attribute. `bind:` anywhere is a located compile error with migration guidance.

  Also removed: the deprecated one-bag `machine(config)` form (use `machine(context, behavior)`), and data-only client machines now accept no events at all (`send` is a compile error — they are seed-and-display). The wire's reserved `@`-prefix rejection stays as defense-in-depth.

  Additional 2.0 surface trims: `defineDirective`/`invoke` and the `Directive*` types leave the public `/template` barrel (documented but unusable from `.stator` files — the directive namespace is closed; a future custom-directive system would be global configuration), and the `StatorDirectiveAttributes` type no longer advertises `bind:`/`class:*`/`style:*` forms the compiler rejects. The Toolchain tier of `/server` is documented as reserved to move to `@statorjs/stator/server/runtime` in a 2.x minor.

### Patch Changes

- 65b70dd: Seam consolidation: cross-tier contracts now have one implementation each. The attribute-value contract (`attrValue`/`sanitizeAttr`/`setAttr` in `wire/attr-value.ts`) is shared by static render, the live diff, the island writer codegen, and the wire applier — previously four drifting copies. Text interpolation shares `textValue` between render and patches, fixing a latent disagreement where a patched array value rendered comma-joined ("a,b") while the static render concatenated ("ab"). Island marker formats are shared constants (`wire/island-markers.ts`), and the component props type is computed once (`statorPropsType`) for both the `.d.ts` generator and the language-server virtual emit. New seam tests pin static-render ≡ patch-apply for attribute and text values, and `.d.ts` ≡ virtual-code props.

## 1.9.0

### Minor Changes

- bc06fb5: Attribute spread `{...rest}` now works in templates, on both elements and components. `<button {...rest}>` forwards a bag of attributes onto the element — static values (with the shared boolean/url semantics) and live machine `read(...)` values, which become real attribute bindings that patch on events — and `<Card {...rest} />` spreads into the component call in source order. This makes the `HTMLAttributes<Tag>` pattern practical: a component can extend a native element and forward every native attribute without hand-plumbing each one (`const { variant, ...rest } = Stator.props<HTMLAttributes<'button'> & { variant }>()` → `<button {...rest}>`). An item read (`read(item, …)`) or a directive invocation used as a spread value is rejected with a clear error.
- 49ff735: `on:` event directives can now be forwarded to a component. `<Button on:click={() => cart.send(…)}>` no longer errors — the parent packs component-level directives into a reserved bag, and the component reads one back with `Stator.forwarded('on:click')` and re-attaches it to whichever inner element it chooses (`<button on:click={onClick} {...rest}>`). This keeps directive syntax on both sides and leaves placement to the component author (no forced forwarding to the root). A forwarded handler that's absent renders no binding rather than crashing. `bind:`/`ref:` forwarding and client-island forwarding are not yet supported.
- 0e6eebd: Components can extend a native element's attributes with `HTMLAttributes<Tag>` — `Stator.props<HTMLAttributes<'button'> & { variant }>()` types and validates every native button attribute plus the component's own props, with no per-attribute forwarding. Attribute values accept live `read(…)` bindings as well as literals. Separately, `JSX.IntrinsicElements` is now typed per element, so a typo on a plain element (`<button typ=…>`) is a compile error; custom-element islands, `raw()` SVG, and unlisted tags stay permissive.
- 9cfd282: A machine instance in a template now types `state` to the machine's state-name union and `send()` to its event union, so `s.state === 'ready'` and `m.send({ type: 'SAVE', … })` autocomplete and a typo — a bad state name, event name, or event payload — is a compile error. Both were previously loose (`state: string`, `send({ type: string })`), so template typos slipped through.

## 1.8.0

### Minor Changes

- 2bac20f: Machines can declare a top-level `on:` — handlers that apply in any state, consulted only when the current state does not declare the event (a state-scoped handler always wins). This is the home for a completion event whose handling must not depend on an unrelated machine-wide state — e.g. a per-record save completing while the machine is busy reloading a collection. Without it, such a completion was silently dropped wherever the current state had no handler for it.
- 425f79d: Reactive regions (`each`/`when`/`match`/`defer`) are now delimited by HTML comment markers (`<!--s:id-->…<!--/s:id-->`) instead of a wrapper `<span style="display:contents">`. This fixes reactive lists and branches inside `<table>`/`<tbody>`/`<tr>`/`<select>`/`<ul>`, where the parser foster-parented the wrapper span out of its container and broke rendering — a reactive `each` of `<tr>` now works. It also stops the framework from injecting a node into your authored DOM, so CSS sibling/child selectors (`.a + .b`, `:nth-child`) match the elements you wrote. No API change; live-update patches address the same slot ids. Region-materializing patches parse through a `<template>`, so table-context fragments survive.

### Patch Changes

- 3fe4620: Fix JSX text whitespace: an inline space next to an interpolation is now preserved, so `{count} unsaved` renders with its space instead of `{count}unsaved`. Text after an expression was losing its leading space (the compiler skipped the text node's leading trivia); whitespace now follows JSX's own rules — inline spaces are significant, newlines and indentation between tags collapse.

## 1.7.1

### Patch Changes

- 23170d0: Data GET routes (`defineApiRoute({ method: 'GET', reads: [...] })`) now type `machines` off the `reads:` tuple, so `machines.SomeMachine` is a typed read proxy instead of `unknown` — selector access typechecks without a cast, and a mistyped machine name is a compile error. A route with no `reads:` gets an empty `machines`.

## 1.7.0

### Minor Changes

- 3a8e5f5: Data GET routes: `defineApiRoute({ method: 'GET', reads, handler })` declares a read-only data route — the handler receives `machines` (read proxies keyed by machine name, the same shape a page render context uses) and structurally no `dispatch`, which is what makes handler reads safe. Machines hydrate under the session lock and the lock is released before the handler runs. A plain return value is served as JSON; a string takes its `Content-Type` from the URL's extension (`routes/feed.xml.ts` serves `/feed.xml` as `application/xml`; also `.txt`, `.ics`, `.csv`); a raw `Response` passes through verbatim. Synthesized responses carry a strong `ETag` and answer `If-None-Match` with a bodyless 304. Extension-named route files that export nothing route-shaped now error at discovery instead of being skipped, `/__sse` and `/__events` refuse route keys that target data routes, and the dev server warns when a `public/` file shadows a data route's URL.
- 9f3c287: `dispatchToApp(machine, event)` is now a method on both `StatorApp` and `DevApp` — the server-originated dispatch plane (webhooks, cron) no longer requires a `store` the dev server never exposed. The dev method follows the current store across rebuilds and runs through the Vite-loaded runtime, so SSE fan-out reaches live connections instead of a second module instance's empty registry. Also in this release: a route file exporting an HTTP-method name with the wrong constructor now errors at discovery instead of being silently skipped as a utility file, and a raw `Response` returned from an API route handler is recognized by shape (not only `instanceof`), with a warning when a return value is neither a `Response` nor a `{patches, directives}` envelope.
- 9f05605: Param segments compose with the data-route extension convention: `routes/p/[id].json.ts` serves `/p/:id.json` — the captured param excludes the literal `.json` (lazily, so dotted ids resolve), and the suffixed route ranks above a bare `/p/:id` page at match time, so a page and its data twin coexist at one URL depth. A rest segment carrying a suffix is an error at discovery.

## 1.6.1

### Patch Changes

- de7d779: Four documented types are now actually importable: `EntryEffect` and `AfterEntry` from `@statorjs/stator/machine` (the field types of the public `StateNode` shape), and `DispatchResult` / `DispatchError` from `@statorjs/stator/client` (what island `dispatch()` resolves with — previously described in the reference but unreachable for annotations). Type-only, no runtime change.

## 1.6.0

### Minor Changes

- e8a60dd: Event dispatch now signals its state instead of failing silently. The dispatching element carries `data-stator-pending` while its POST is in flight, live routes carry `data-stator-connection` on `<html>` (`connected` / `disconnected` / `stale`), every request gets a 10-second deadline instead of hanging on browser defaults, and failures fire a `stator:dispatch-error` window event (also shown as a row in the dev inspector). Island `dispatch()` results gain an `error` field saying whether the failure was `network`, `timeout`, or `http`.
- e8a60dd: Event POSTs are now idempotent and retried. Every machine-event dispatch carries a client-generated `eventId`; the server caches the response per session and replays a duplicate verbatim instead of re-applying it (keyed-list patches are positional, so a double-apply was never safe). On top of that, the client retries network failures and timeouts twice with backoff, reusing the same id — a tap on flaky wifi now recovers instead of silently dropping. Non-2xx responses and enhanced form submits are never retried.

### Patch Changes

- e8a60dd: Live pages resync instead of reloading after a dropped or stale SSE connection. The server already pushes a full initial sync on every fresh connection, so the client now just reopens the channel and lets that sync converge the page in place — scroll, focus, and island state survive where a reconnect previously forced a full page reload. The half-open-channel watchdog rebuilds the connection the same way.

## 1.5.2

### Patch Changes

- 3cb1fc3: Live pages recover from zombie SSE connections. The server heartbeat is now an observable data frame (`{"ping":true}`) instead of a comment, and the client runtime watches for it — two missed pings on a visible page closes the dead channel and reloads to re-sync. Fixes live updates silently stopping after device sleep or a silent network drop, which previously left pages looking connected while receiving nothing (surfaced as a refresh spinner that never stopped).

## 1.5.1

### Patch Changes

- 27d2efc: The circular-import subscription error now recommends the read/write split (a third machine reading both sides) and no longer suggests defining both machines in one module, which directory discovery — default exports only — cannot load.

## 1.5.0

### Minor Changes

- 9912f0c: Template internals are typecheckable in CI. `syncTypes` now also emits each template's virtual TSX under `.stator/check/` — add it to a project's tsconfig `rootDirs`/`include` and plain `tsc --noEmit` catches frontmatter and prop errors that previously surfaced only as runtime ReferenceErrors. Client-island d.ts props now derive from `static attrs` and accept live `read()` bindings, matching what the runtime always supported.
- 913edf3: Work-lifetime contract for state-anchored effects and timers. Entry effects are the load role — re-invoked on hydration when a process died mid-flight (same effectId), abortable via meta.signal on state exit. Transition effects are the command role — at-most-once, never re-invoked. `after` timers re-arm on hydration with elapsed credit, so restarts no longer silently kill countdowns. Machine-driven re-entries no longer refresh the session TTL, and out-of-band events for expired sessions are dropped instead of resurrecting fresh machines.

### Patch Changes

- bfda194: The dev server warns when a session machine self-reschedules through `after` with a data-loading entry effect on the loop — server-side polling that runs for sessions nobody is watching. After-rescue timeouts and app-machine housekeeping stay quiet.
- 9912f0c: The editor's virtual code applies the same HTML-to-TSX compatibility as the emitted check files — HTML comments, is:inline scripts, and unclosed void elements no longer produce false syntax errors in-editor, and offset mappings stay exact around every edit. One transform, both surfaces.

## 1.4.1

### Patch Changes

- 27c3e64: class:list and style:list specs re-resolve their machine reads against the current proxy on fan-out recompute — a long-lived SSE connection previously composed the attribute from the actor frozen at connect time, so the attribute never patched over a live connection.

## 1.4.0

### Minor Changes

- c1ead4a: Item reads work in attribute position — `checked={read(item, (i) => i.done)}`, `style={read(item, (i) => `width: ${i.pct}%`)}` — with the same semantics as machine attr reads (false/null removes the attribute, true renders it bare), patching the row's stable element id across moves.
- 4364f6e: Add `defer` for async data in synchronous routes. `defer(thunk, { ready, error })` marks an async region the framework resolves outside the sync render — the thunk is kicked during render, awaited in parallel with every other defer on the page (bounded by the slowest), then rendered inline. Frontmatter stays synchronous; sync/already-resolved data fills with no placeholder. The thunk never runs under the `/__events` lock.

  `defer` is the one-shot, view-scoped door for async data (a machine is the reactive door). A machine read inside a defer arm is a build-time error — caught in the compiler, dev overlay, and editor — since a defer slot is static and never re-diffed. See the "Fetching data: defer vs a machine" recipe.

- c519a1d: `read(item, selector)` inside an `each` makes an item field live: a content change patches just that field in place instead of re-rendering the row (keyed and non-keyed), and identity churn no longer re-renders it. `read()` stays the one marker for live data — a plain `{item.field}` still renders once.

### Patch Changes

- c8ced68: Dev inspector: the change-flash no longer masks the element it highlights (outline-only), and its styles are isolated in a low-priority `@layer stator-inspector` so your app's styles always win.
- 8becc64: Dev inspector: the toolbar is now a `<stator-inspector>` custom element with a shadow root, so an app's global styles (e.g. a bare `button` reset) can no longer restyle it. The element flash stays document-level in the lowest-priority `@layer stator-inspector` — the app still always wins over anything the inspector paints on the page.
- 18e5004: Dev inspector: live (SSE) updates now show their apply time in the panel, and the element flash only fires while the drawer is open.
- c224272: An item read is owned by its `each` row, and the compiler now enforces the placement that implies: `read(item, …)` inside a `when`/`match`/`defer` arm, reading an outer item from a nested `each`, or inside a `class:list`/`style:list` spec are compile-time errors that name the fix. Arms re-render without their row — previously this crashed recompute at runtime.

## 1.3.0

### Minor Changes

- 3577147: Add `after` state timeouts: a state may declare `after: [{ delay, send }]` to dispatch `send` after `delay` ms in the state (armed on entry, cancelled on exit; `delay` may depend on context). The companion to entry effects — rescues a state whose entry effect never completes. Timers are in-memory and non-durable (a restart drops them); on fire the event is guard-dropped if the state has already moved on.

  Entry effects and `after` now also work on app-lifecycle machines, firing on wall-clock with no session (self-revalidating caches, circuit breakers). Also fixes a chained effect being dropped when one effect's completion triggers another.

- 19aa165: Entry effects. A state can now declare an `entry` async effect that the host schedules when the state is _entered_ — a fresh start at the initial state, or a value-changing transition; never on hydration. It reuses the transition-effect pipeline (host-scheduled off the session lock, at-most-once, completion re-enters through the normal event path and reaches live pages over SSE), minus the event argument, and its return is type-checked against the machine's event union like a transition effect.

  This is the trigger the reactive-load pattern needs: a machine that starts in `loading`, fetches in its entry effect, and moves to `ready`/`error`. A GET that first loads such a machine now persists the entered state (so it isn't re-created and re-fired next request) and schedules the effect off-lock after the response; the common GET with no entry effect stays a lock-free read.

## 1.2.2

### Patch Changes

- a1e027d: Language server: frontmatter is now modelled as a synchronous function body in the editor, matching the runtime. The virtual-code emitter hoists imports/types to module scope and places the executable frontmatter inside the render function, so a top-level `await` (or `return`) in a `.stator` frontmatter is flagged as a TypeScript error in-editor instead of being silently accepted. Closes a divergence where the editor typechecked frontmatter at module scope — where top-level `await` is legal — while the runtime wraps it in a sync function.

## 1.2.1

### Patch Changes

- d0963de: Security hardening across the server, engine, template, and wire layers. Same-origin apps are unaffected; the behavior changes only reject abusive or unsafe inputs.

  - **Engine `@set` is no longer dispatchable from the wire.** The built-in `@set` context-write (which powers client-island `bind:value`) is now honored only by client-island actors; server actors ignore it and `/__events` rejects any reserved `@`-prefixed event with a 400. Previously a client could `@set` arbitrary context on any session machine, bypassing every guard (privilege escalation / identity forgery).
  - **Static file serving is contained to its root.** `/static/*` now verifies the resolved path stays under `staticDir`, closing an absolute-path escape (`/static//etc/passwd`) that allowed unauthenticated arbitrary file reads.
  - **URL-scheme sanitization.** `href`/`src` and other url-bearing attributes strip `javascript:`/`vbscript:` (both at render and on live diffs; `data:` images preserved); navigation directives and server redirects reject `javascript:`/`vbscript:`/`data:` targets and only bounce back to a same-origin `Referer`.
  - **Attribute escaping** now also escapes single quotes (`'`), closing a single-quoted-attribute breakout.
  - **CSRF origin check.** Mutating routes (`/__events` and API routes) reject browser requests whose `Sec-Fetch-Site`/`Origin` is cross-site; cookieless server-to-server callers are unaffected.
  - **Session-lock timeout.** A hung mutation no longer wedges a session's mutation path indefinitely.
  - **`style:list`** reactive property values are cut at the first `;` to prevent CSS declaration injection.

## 1.2.0

### Minor Changes

- 1b8eb1f: `rotateSession()` in API route helpers — the session-fixation defense for
  privilege changes. Call it on login and the whole session (every persisted
  machine) moves to a freshly minted id, with the response carrying the new
  cookie; call `rotateSession({ clear: true })` on logout and the old
  session's state is deleted outright. Backed by a new optional
  `renameSession` on the `Store` interface, implemented by all built-in
  stores (in-memory, Redis via atomic `RENAME`, cached write-through).

### Patch Changes

- 8739e88: Every server dispatch surface now reports whether the event actually
  committed, matching the client dispatch contract: API-route `dispatch()`
  and `dispatchToApp()` both return `{ committed: boolean }`. Login-style
  handlers can distinguish a guard-dropped event (wrong credentials) from a
  committed one, and webhook receivers can tell a processed event from a
  guard-dropped duplicate.

## 1.1.1

### Patch Changes

- e8871d3: Port collisions stopped being stack traces. The dev server now shifts to the
  next free port when the requested one is busy (noted in the banner) and
  probes a free HMR websocket port, so two Stator apps run side by side
  without fighting over 24678. Production stays strict about its port but
  fails with a one-line message instead of an unhandled `EADDRINUSE`.
