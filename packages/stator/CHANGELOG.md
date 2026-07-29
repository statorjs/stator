# @statorjs/stator

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
