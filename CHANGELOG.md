# Changelog

Versioning: the 0.9 line is the release-candidate surface for 1.0. Per the
project's versioning decision, **1.0.0 ships only after the proving demo
validates the API without breaking changes**. Subpaths `server`, `machine`,
`template`, `client`, `dev`, `build`, and `components` are treated as stable
from 0.9.0; `compiler` and `vite` are internal and may change in minors.

## @statorjs/stator 1.0.0 — 2026-07-08

The proving-demo release: everything the storefront demo
([demo.statorjs.dev](https://demo.statorjs.dev)) forced the framework to get
right. The 0.9 API survived a real application without breaking changes;
these are the hardening fixes and the features it earned along the way.

### New

- **Reads-aware selectors**: selectors receive the same `{ reads }` helpers
  as actions/guards, so cross-machine verdicts project as display state —
  and bindings on the reading machine re-diff when a read machine changes.
- **Boolean attribute bindings**: `disabled={read(…)}` renders absent for
  falsy, present-and-empty for `true`; attr patches carry `value: null` for
  removal (wire change, pre-publish).
- **`dispatch()` returns `{ ok, committed, patchCount }`** — a guard-dropped
  event is `ok && !committed`; the POST envelope carries `committed`.
- **Island attribute reactivity**: declared attrs are observed; changes
  invoke coerced `${key}Changed(next)`. Island props accept `read()` —
  live server-bound attributes.
- **The hydrate pattern, pinned**: island templates render server sections
  from props (maps with nested JSX, component renders as props, `read()`);
  `html\`\`` splices fragment arrays.
- **Production inspector**: `createApp({ inspector: true })` serves + injects
  the wire inspector toolbar.
- **Emit-cascade guards**: wire-time subscription-cycle warning, runtime
  depth cap with a named trail, circular-import diagnosis.

### Fixed

- Live views: initial-sync on SSE connect (pages that missed changes
  mid-navigation converge); fan-out rehydrates session actors from the
  Store and scopes session touches to the owning session; the dispatching
  page's own connection is skipped (double-insert fix).
- Wire contract: route keys carry the page's query string into baseline
  re-renders; branch arms scope their slot ids (`s2:btrue:s0`) so stale
  pages skip instead of miswrite; the applier warns on missing targets.
- `buildApp` mirrors the app's source tree (machines importing `lib/` no
  longer break production builds).
- Client components scope CSS by descendant of the root — runtime-created
  island DOM matches scoped styles.
- Touched means committed: guard-dropped events no longer persist, fan out,
  or report `committed: true`.

### Docs

- Testing guide (the inverted pyramid), divergence contract, islands-are-
  leaves channels, command-endpoint API routes, mutual-machine wiring, 404
  idiom, converging completions, reads-aware selectors.

## @statorjs/stator 0.9.0 — 2026-07-04

The "everything since the POC" release: the 1.0 feature surface, complete.

### Engine & machines

- Custom isomorphic state-machine engine (replaces XState): flat typed state
  graphs, `to`/`when`/`do`/`emit` transitions, mutation-syntax actions over
  `structuredClone` drafts, declared emits, snapshot persistence.
- **Async effects**: `effect: async (ctx, ev, { effectId }) => Events | null`
  on transitions — host-scheduled after commit, never under the session lock;
  completions re-enter the normal event path and reach live pages over SSE.
  Works on session machines, app machines, and client islands. At-most-once,
  non-durable (durability is 1.x).
- Typed machine-mediated dispatch: machines addressed by imported def, events
  checked against each machine's declared union, server and client.
- **App-machine persistence** (`persist: true`) through a new `AppStore`
  interface (`InMemoryAppStore`, `RedisAppStore`); boot hydration with
  log-loud-start-fresh recovery.
- **`dispatchToApp`**: typed server-originated dispatch for webhooks and cron
  — send, persist, fan out to live connections. `createApp` now exposes
  `store` for it.

### Templates & rendering

- `.stator` single-file components (TS frontmatter + JSX template + scoped
  CSS), compiled to server render modules; file-based routing with path
  params, `// @stator live` pragma, GET-`.stator` + POST-`.ts` route merge.
- **Keyed lists**: `each(items, fn, { key })` emits per-item
  `insert`/`remove`/`move` patches from a server-side diff; rows keep
  identity (focus, transitions) across reorders; key-derived slot scopes.
- Wire protocol consolidated into one shared module (`src/wire/`) both sides
  typecheck against; documented in WIRE.md.

### Client islands

- Whole-file custom elements (structural detection, no pragma): `use()` with
  hydration seeds, two-way `bind:`, typed `dispatch` to server machines.
- **Production island builds**: `buildApp` bundles islands via Vite into
  hashed assets with a route→island manifest; `loadProductionHead` injects
  per-route scripts. Server-machine imports collapse to `{ name }` identity
  stubs in browser bundles (dev and build).

### Server & ops

- SSE live routes with cross-session fan-out (single replica); per-session
  store adapters (`InMemoryStore`, `RedisStore`, write-through `CachedStore`).
- One shared per-session lock across `/__events` and API routes (fixes a
  cross-path lost-update race).
- Hardened `/__events` input handling; automatic HTML escaping verified
  against XSS payloads; session cookie flags (`HttpOnly`, `SameSite=Lax`,
  `Secure` gating) under test.
- `@hono/node-server` moved to dependencies (was devDependency — broke real
  consumers); `pino-pretty` is now optional with a graceful JSON fallback.

### Tooling & DX

- `create-stator` scaffolder (`pnpm create stator my-app`).
- Vite-embedded dev server: live reload, compile-error overlays with code
  frames, auto-injected client runtime and dev inspector.
- VSCode extension + Volar language server for `.stator` (highlighting,
  TS/CSS intelligence across regions).
- Docs site: tutorial (9 chapters), concepts, guides, hand-written API
  reference.

## @statorjs/language-server 0.1.0 — 2026-07-04

- First versioned cut: Volar language plugin + Node server; TS and CSS
  services federated across `.stator` regions.

## create-stator 0.9.0 — 2026-07-04

- Initial release: prompt-free scaffold with a complete working app template
  (dev/build/start/sync wiring, counter machine, `.stator` pages).
