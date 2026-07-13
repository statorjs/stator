<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Stator logo — a stator ring with inward poles around a rotor" width="56" height="56">
</picture>

# stator

> A server-canonical web framework where business logic lives in composable
> state machines that have no awareness of the UI, and the UI is a thin
> renderer binding machine outputs to DOM positions.

Machines are the canonical state: templates read from them, events are how
anything changes, and the server is authoritative. Each interaction POSTs an
event, the machine transitions, and the framework diffs the affected bindings
into a small JSON patch list — no client-side app state by default. Where the
UI genuinely needs to feel instant, a `.stator` file becomes a **client
island**: the same machine engine running in the browser as a custom element.

Design rationale and per-feature specs live in
[`.chisel/specs/`](./.chisel/specs/) (shipped + draft), managed via the
[Chisel](https://chisel.build) CLI. Developer docs (tutorial, concepts,
guides) live in [`apps/docs`](./apps/docs) — `pnpm --filter docs dev`.

## Quickstart

```bash
pnpm install
pnpm dev
# open http://localhost:3000
```

You'll see Desksmith, a small shop. Click "Add to cart" and the header cart
counter and button label update via slot patches — no page reload. `/cart`
changes quantities, `/checkout` walks a guarded 3-state flow, and the theme
toggle in the header is a client island (client-only state, zero server
round-trips). Open `/admin` in another tab for a live cross-session dashboard:
every visitor's cart appears there in real time over SSE.

## Authoring model

A **`.stator` single-file component** is TS frontmatter + a JSX-flavored
template (+ optional scoped `<style>`):

```
---
import Cart from '../machines/cart.ts'

const [cart] = Stator.reads([Cart])
---

<p>Items: {read(cart, (c) => c.itemCount)}</p>
<button on:click={() => cart.send({ type: 'ADD', productId: 'p1' })}>Add</button>
```

A **machine** is a typed, flat state graph:

```ts
export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',           // or 'app' — one shared instance per server
  events: {} as CartEvents,       // typed event union; send() is checked
  context: { items: [] as Item[] },
  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD: (ctx, ev) => { ctx.items.push(/* … */) },   // mutate a draft; engine commits
        CHECKOUT: {
          to: 'checking-out',
          when: (ctx) => ctx.items.length > 0,           // guard
          effect: async (ctx, ev, meta): Promise<CartEvents | null> => {
            // async I/O runs AFTER commit, never under the session lock;
            // the returned event dispatches through the normal path
            const res = await charge(ctx, meta.effectId /* idempotency key */)
            return res.ok ? { type: 'CHARGE_OK' } : { type: 'CHARGE_FAILED' }
          },
        },
      },
    },
  },
  selectors: { itemCount: (ctx) => ctx.items.length },
})
```

A **client island** is a whole-file custom element — the file kind is
structural (an exported `StatorElement` subclass whose name kebab-matches the
root tag), not a pragma:

```
<theme-toggle>
  <button on:click={toggle}><span bind:text={theme.label}></span></button>
</theme-toggle>

<script>
  const Theme = machine({ mode: 'light', on: { TOGGLE: (s) => { /* … */ } } })
  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>
```

Server machines imported in client code collapse to identity stubs
(`{ name }`) in browser bundles — `dispatch(Cart, event)` crosses the wire,
the machine's body never does.

## What's here

- **Custom isomorphic engine** — flat typed state graphs (`to`/`when`/`do`/
  `emit`/`effect`), mutation-syntax actions over `structuredClone` drafts,
  declared emits, snapshot persistence. Runs identically server- and
  client-side; a few KB, not a statechart library.
- **Engine effects** — async I/O declared on transitions, host-scheduled
  after commit. The session lock is never held during I/O; completions
  re-enter the normal event path and reach live pages over SSE. At-most-once,
  non-durable in 1.0 (durability rides the 1.x inbox).
- **`.stator` compiler + Vite plugin** — SFCs compile to server render
  modules (and client modules for islands); scoped CSS; dev server with
  live-reload, compile-error overlays with code frames, and an auto-injected
  inspector toolbar.
- **Production build** — `buildApp` compiles to a `dist/` of plain TS served
  with no Vite, bundles islands to hashed assets with a route→island
  manifest, and `loadProductionHead` injects the right script tags per route.
- **Keyed `each`** — `each(items, fn, { key })` emits per-item
  insert/remove/move patches from a server-side diff; rows keep identity
  (focus, transitions) across reorders. Unkeyed lists re-render whole.
- **Wire protocol** — documented in [`WIRE.md`](./WIRE.md); a single shared
  module both sides typecheck against.
- **SSE live routes** — `live: true` opens a per-connection stream; every
  state change fans out patches to connections whose route reads a touched
  machine, across sessions. `dispatchToApp` pushes server-originated updates
  (webhooks, cron) through the same path.
- **Persistence** — session machines through a `Store` adapter (`InMemoryStore`
  default, `RedisStore` + write-through `CachedStore` in-box); app machines
  opt in with `persist: true` through an `AppStore` (`RedisAppStore` in-box).
- **Typed dispatch** — machines are addressed by imported def, events check
  against the machine's declared union, on both server and client.
- **Editor tooling** — a Volar-based language server + VSCode extension
  (syntax highlighting, TS/CSS intelligence across regions) in
  [`editors/vscode`](./editors/vscode).

## Layout

```
packages/stator/         # the framework (@statorjs/stator)
  src/
    engine/              # defineMachine, createActor — isomorphic core
    server/              # routing, HTTP, SSE, stores, effects, dispatch
    template/            # html`...`, read, each, when/match, directives
    compiler/            # .stator → server module + client module
    vite/                # Vite plugin + machine-import stubbing
    build/               # production build + head injection
    client/              # page runtime + island runtime (StatorElement)
    wire/                # the patch/directive protocol, shared by both sides
packages/language-server # Volar-based .stator language server
editors/vscode           # VSCode extension (grammar + LSP client)
examples/desksmith       # the tutorial's companion app (cart/checkout, all .stator)
examples/live-poll       # shared app-machine state + cross-session SSE
apps/docs                # developer docs (Astro Starlight)
```

## Roadmap

Where this is going — and why each item earned its place — lives in
[ROADMAP.md](ROADMAP.md): upcoming example starters, docs recipes, and the
primitives our own apps proved missing.

## Known limitations (1.0 scope)

- **Single replica.** SSE fan-out and app machines are in-process. The
  Redis-backplane path for horizontal scaling is designed and deferred
  to 1.x.
- **Flat machines.** No nested/parallel/history states or `invoke` — the
  snapshot format reserves the shape; richness is 1.x extension points.
- **Effects are at-most-once.** A crash between commit and completion loses
  the effect (the machine stays in its pending state). Durable effects ride
  the 1.x inbox work.
- **Templates must parse as TSX** — a permanent design constraint (it's what
  makes the compiler and LSP cheap). No modifier syntax (`on:click.prevent`);
  compose typed wrappers instead.
- **App machines are emit-driven** from sessions (plus `dispatchToApp` from
  server code); there is no direct client→app dispatch yet.
- **`subscribes:` is callback-shaped.** Declarative source/predicate/transform
  subscriptions are 1.x.

## Scripts

| from repo root   | what it does                                       |
|------------------|----------------------------------------------------|
| `pnpm install`   | install workspace deps                             |
| `pnpm dev`       | run the example app with the dev server            |
| `pnpm test`      | full test suite (Redis tests skip without a server)|
| `pnpm test:redis`| just the Redis integration tests (localhost default)|
| `pnpm typecheck` | `tsc --noEmit` across the workspace                |
| `pnpm lint`      | Biome (lint + format check)                        |

## Deploy (Fly.io + Upstash Redis)

The example app deploys on Fly.io with Upstash Redis for session storage.
Single small machine, always-on (SSE connections need the process running).

```bash
fly launch --no-deploy --copy-config        # adopts fly.toml; pick app name
fly secrets set REDIS_URL='rediss://default:<pw>@<host>:6379'
fly deploy
```

**Env vars:**

| | |
|---|---|
| `REDIS_URL` | Upstash / Fly Redis connection string. `rediss://` for TLS. |
| `PORT` | Listen port. Defaults to `3000`. Fly sets this automatically. |
| `NODE_ENV` | `production` enables the Secure cookie flag. |
| `LOG_LEVEL` | `debug` / `info` (default) / `warn` / `error`. |
| `SESSION_TTL_SECONDS` | Per-session idle TTL. Defaults to `86400` (24h). |
| `STATOR_SECURE_COOKIE` | `1` / `0` — overrides `NODE_ENV` cookie behavior. |

The demo's `/admin` route is intentionally open — it exists to demonstrate
cross-session SSE, and no PII is collected anywhere (product ids and
quantities only).

## License

MIT — see [LICENSE](./LICENSE).
