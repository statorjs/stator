# stator

> Proof-of-concept of a server-canonical web framework where business logic
> lives in composable state machines that have no awareness of the UI, and the
> UI is a thin renderer binding state-machine outputs to DOM positions.

This repo is the POC implementation. Design rationale and per-feature
specs live in [`.chisel/specs/`](./.chisel/specs/) (shipped + draft work),
managed via the [Chisel](https://chisel.build) CLI.

## Quickstart

```bash
pnpm install
pnpm --filter example start
# open http://localhost:3000
```

You'll see a 4-product shop. Click "Add to cart" on any product and the header
cart counter and the button label both update via slot patches — no full page
reload. Navigate to `/cart` to change quantities, then `/checkout` to walk
through a 3-state checkout flow with guards.

Open `/admin` in another tab to see a live cross-session dashboard: every
visitor's cart shows up there in real time, pushed over SSE as they interact.
That route is `live: true`; shopping pages aren't. Open two windows on `/` and
watch `/admin` update without polling.

## Layout

```
packages/stator/         # the framework
  src/
    server/              # defineMachine, MachineStore, discovery, routing, HTTP
    template/            # html`...`, read, each, on, defineDirective, parser
    client/              # the browser runtime (~100 LOC, bundled by esbuild)
  tests/                 # vitest unit + integration tests

apps/example/            # the cart-and-checkout demo
  machines/              # cart.ts, products.ts, checkout.ts
  templates/             # layout, product-list, cart-page, checkout-page
  routes/                # file-based routing — GET / → routes/index.ts
  static/                # global CSS
  server.ts              # createApp(...).listen(3000)
```

## What's here

- **`defineMachine`** wraps XState v5 with a stator-specific config shape
  including `name`, `lifecycle: 'app' | 'session'`, `reads: [...]`, `emits`,
  `selectors`. Actions look like `(ctx, ev) => void` and are wrapped to use
  XState `assign` under the hood with a per-call `structuredClone` so mutation
  syntax is safe.
- **Machine discovery** is file-based: every `*.ts` in the machines directory
  is dynamically imported, validated, dependency-sorted (Tarjan-style cycle
  detection), and instantiated.
- **Templates** are tagged template literals. `html\`...\`` calls a small
  streaming parser that classifies each interpolation as `text`,
  `attr-value`, or `directive`. `read(instance, selector)` registers a slot
  binding; `each(items, fn)` opens a list scope; `on(modifier, handler)`
  is the first user of `defineDirective`.
- **Slot tracking** lives entirely at runtime: each render produces a
  `RenderState` mapping slot IDs to bindings, plus a reverse index by machine
  name. When an event POSTs to `/__events` and a machine transitions,
  `recompute` walks the bindings tied to that machine, re-runs each selector,
  diffs against `lastValue`, and emits patches.
- **Routing** is file-based, with each route file exporting named `GET` /
  `POST` handlers built via `defineRoute({ reads, render })`. The render
  function receives an object keyed by machine `name`.
- **Wire protocol** is documented in [`WIRE.md`](./WIRE.md). Patches use a
  discriminated `{ target: { kind, id }, op, ... }` shape — slot vs element
  addressing as orthogonal dimensions from the op (text / html / attr).
- **SSE for live routes**. Routes declared with `live: true` open an
  EventSource on render; the framework fans out push patches to every open
  connection whose route reads a touched machine. `/admin` uses this; shopping
  pages don't (their POST responses cover their own updates).
- **Persistence via a Store adapter**. `InMemoryStore` is the default;
  `RedisStore` ships in-box for production. Per-session TTL refreshes on every
  state-changing event — idle sessions expire as a whole.
- **Client runtime** (~100 LOC) attaches delegated listeners on `document.body`
  for click / submit / change / input. On fire, it reads `data-event-<type>`
  from the closest ancestor, POSTs the JSON descriptor with an `X-Stator-Route`
  header derived from `location.pathname`, and applies the returned patches.

## POC limitations (will lift in V1)

- **`on(...)` handlers must be exactly one `machine.send(...)` call.** The
  handler runs once at server-render to capture the event descriptor.
  Multi-statement handlers (e.g. `preventDefault` + send) are not supported.
- **`each` re-renders the whole list on any change to its source array.**
  Per-item keyed diffing is V1. Inputs inside `each` will lose focus on
  any list-shape change — avoid for now.
- **Strict template subset.** Always quote attribute values; no HTML comments
  inside templates; no inline `<script>` or `<style>`. The parser throws
  with a clear message on violations.
- **Synchronous templates only.** No `await` inside `defineRoute`'s `render`
  function or inside selectors — the render context is a module-scoped
  variable that doesn't survive async boundaries.
- **Read selectors are the unit of reactivity.** Conditional logic must live
  *inside* the selector function, not in the template ternary around the
  `read(...)` call. Write `read(cart, c => c.contains(id) ? 'a' : 'b')`, not
  `read(cart, c => c.contains(id)) ? 'a' : 'b'`.
- **No schema CLI / dev tools / hot reload.**
- **No keyed `each`.** Lists re-render their full body on shape changes;
  per-item insert / remove / move patches are reserved in the wire format
  for V1.
- **No type-safe `send` payloads.** Action and guard event arguments are
  typed `any`. Full event-typing is part of the V1 custom machine impl.
- **`tsx` runtime, no build step.** Production runs `tsx server.ts`; the
  startup TS-transform cost is paid once per machine boot. A real build
  pipeline lands with the V1 SFC compiler.

## Scripts

| from repo root              | what it does                                        |
|-----------------------------|-----------------------------------------------------|
| `pnpm install`              | install + build esbuild postinstall                 |
| `pnpm typecheck`            | `tsc --noEmit` across the workspace                 |
| `pnpm test`                 | run framework unit + integration tests via vitest   |
| `pnpm dev`                  | `tsx watch` the example app on `localhost:3000`     |
| `pnpm --filter example start` | run the example app once (no watch)               |

## Deploy (Fly.io + Upstash Redis)

The example app is configured to deploy on Fly.io with Upstash Redis for
session storage. Single small machine, always-on (no scale-to-zero — SSE
connections need the process to keep running).

**Prereqs:** `flyctl` installed, signed-in Fly account, an Upstash Redis
database (or Fly-managed Redis if their integration is current).

```bash
# 1. Initial setup (once per app)
fly launch --no-deploy --copy-config        # adopts fly.toml; pick app name
fly secrets set REDIS_URL='rediss://default:<pw>@<host>:6379'

# 2. Deploy
fly deploy
```

The `fly.toml` defaults:

- `auto_stop_machines = "off"`, `min_machines_running = 1` — required for SSE.
- `shared-cpu-1x` / 512 MB — comfortable for the demo's memory profile.
- `force_https = true` — pairs with `NODE_ENV=production` which enables the
  Secure cookie flag.

**Without `REDIS_URL`**, the app falls back to `InMemoryStore` and logs a
warning. Sessions die on every deploy. Useful for local dev or smoke tests;
not for a live demo.

**Env vars:**

| | |
|---|---|
| `REDIS_URL` | Upstash / Fly Redis connection string. `rediss://` for TLS. |
| `PORT` | Listen port. Defaults to `3000`. Fly sets this automatically. |
| `NODE_ENV` | `production` enables Secure cookie and JSON logs. |
| `LOG_LEVEL` | `debug` / `info` (default) / `warn` / `error`. |
| `SESSION_TTL_SECONDS` | Per-session idle TTL. Defaults to `86400` (24h). |
| `STATOR_SECURE_COOKIE` | `1` / `0` — overrides `NODE_ENV` cookie behavior. |

The `/admin` route is intentionally open in the demo — it shows every
visitor's cart in real time and exists to demonstrate cross-session SSE. The
page banner explains this. No PII is collected anywhere in the demo (productIds
and quantities only).

## License

MIT — see [LICENSE](./LICENSE).
