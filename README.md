# stator

> Proof-of-concept of a server-canonical web framework where business logic
> lives in composable state machines that have no awareness of the UI, and the
> UI is a thin renderer binding state-machine outputs to DOM positions.

This repo is the POC implementation. The full design and rationale lives in
[`framework-poc-spec.md`](./framework-poc-spec.md).

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
- **Wire protocol**: `POST /__events` accepts `{ machine, event }` validated
  by zod, returns `{ patches: Patch[] }` where each patch is one of:
    - `{ slot, value }` — text content
    - `{ slot, attr, value, parentId }` — attribute on a synthetic-id parent
    - `{ slot, html }` — innerHTML replacement (full list re-render)
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
- **In-memory state only.** No persistence adapter; session state is lost on
  server restart.
- **No SSE / live updates.** Request-response only.
- **No schema CLI / dev tools / hot reload.**

## Scripts

| from repo root              | what it does                                        |
|-----------------------------|-----------------------------------------------------|
| `pnpm install`              | install + build esbuild postinstall                 |
| `pnpm typecheck`            | `tsc --noEmit` across the workspace                 |
| `pnpm test`                 | run framework unit + integration tests via vitest   |
| `pnpm dev`                  | `tsx watch` the example app on `localhost:3000`     |
| `pnpm --filter example start` | run the example app once (no watch)               |

## License

Unlicensed POC — not for production use.
