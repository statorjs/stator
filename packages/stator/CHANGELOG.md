# @statorjs/stator

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
