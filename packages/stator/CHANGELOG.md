# @statorjs/stator

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
