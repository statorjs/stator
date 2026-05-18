# stator

Server-canonical web framework where business logic lives in composable
state machines. POC — see [the repo root](../../README.md) for the broader
picture and quickstart, and [`WIRE.md`](../../WIRE.md) for the patch protocol.

## Storage model — read this first

stator is **request-scoped actors with persistent state via a Store**, not
session-lifetime actors that happen to persist. The distinction matters:

- Between requests, **no per-session state lives in the server's memory.**
  Session-lifecycle machine state is held in a `Store` (the default
  `InMemoryStore` is process-memory; V1 adapters swap in Redis/KV/Postgres)
  as serialized XState snapshots.
- During a request, a `SessionRuntime` selectively hydrates the machines the
  request touches into transient actors, processes the event, persists the
  resulting snapshots back to the Store, and disposes everything before the
  response is sent.
- Cross-machine event subscriptions are re-wired per request from the
  declarative `subscribes:` graph. They are not long-lived listeners.

Net: server memory bound is `(concurrent in-flight requests + future open
SSE connections)` × `(machines hydrated per request)`, not `(every session
ever seen)` × `(every route ever visited)`.

App-lifecycle machines are the exception — they live in process for the
duration of the server. Their state is shared across all sessions and not
persisted by the Store layer.

## Subpath exports

```ts
import { defineMachine, defineRoute, createApp } from '@statorjs/stator/server'
import { html, read, each, when, match, on, classList, styleList } from '@statorjs/stator/template'
// '@statorjs/stator/client' is the browser runtime — not imported from server code
```

## `@statorjs/stator/server`

### `defineMachine(config)`

```ts
import CheckoutMachine from './checkout.ts'
import ProductsMachine from './products.ts'

defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',                // 'app' | 'session'
  reads: [ProductsMachine],            // machines this one can read selectors from
  emits: ['ITEM_ADDED', 'CART_CLEARED'],
  subscribes: [
    // Cross-machine event delivery. Receiver-side declaration.
    { from: CheckoutMachine, event: 'ORDER_PLACED', dispatch: 'CLEAR' },
  ],
  context: { items: [] as CartItem[] },
  initial: 'idle',
  states: {
    idle: {
      on: { ADD_ITEM: { actions: 'addItem', emit: 'ITEM_ADDED' } },
    },
  },
  actions: {
    addItem: (ctx, ev, { reads }) => {
      // reads.ProductsMachine is the live proxy for ProductsMachine,
      // resolved via the active SessionRuntime.
      const product = reads.ProductsMachine.byId(ev.productId)
      if (!product) return
      ctx.items.push({ productId: ev.productId, quantity: 1, unitPrice: product.price })
    },
  },
  guards: { /* (ctx, ev, { reads }) => boolean */ },
  selectors: {
    itemCount: (ctx) => ctx.items.reduce((s, i) => s + i.quantity, 0),
    contains: (ctx) => (id: string) => ctx.items.some(i => i.productId === id),
  },
})
```

Action and guard signatures take `(ctx, event, { reads })`. The `reads`
helper is populated from the machine's declared `reads:` array — typo-safe
at the dispatch-context boundary; throws clearly if dereferenced outside an
active dispatch (e.g. an action called directly via `actor.send` in a test).

### `defineRoute({ reads, render })`

Routes are files in the routes directory exporting named HTTP-method handlers:

```ts
// routes/cart.ts → GET /cart
import { defineRoute } from '@statorjs/stator/server'
import CartMachine from '../machines/cart.ts'
import cartPage from '../templates/cart-page.ts'

export const GET = defineRoute({
  reads: [CartMachine],
  render: ({ CartMachine: cart }) => cartPage(cart),
})
```

The `reads:` array drives selective hydration: only the listed machines
(plus everything transitively reachable via their own `reads:` and
`subscribes:` graphs) are loaded into the request's `SessionRuntime`.

### `createApp({ machinesDir, routesDir, staticDir, store? })`

Discovers machines, validates the dependency graph, builds the Hono app,
and returns `{ listen(port), fetch }`. `fetch` is useful for testing —
hit `app.fetch(new Request(...))` directly. The optional `store` overrides
the default `InMemoryStore`.

## `stator/template`

### `html\`...\``

Tagged template literal. Each `${...}` interpolation is classified by parser
state as `text`, `attr-value`, or `directive`. The function returns an
`HtmlFragment` that's safe to embed in other templates.

Attribute values must come from a single source — a literal, a single
`read(...)`, or a directive owning the whole attribute. Mixing literal text
with `${read(...)}` in an attribute throws at render time. Use `class:list`
/ `style:list` for the compound case.

### `read(instance, selector)`

Registers a slot binding. The selector takes the proxy and returns the rendered
value. Wrap conditional logic *inside* the selector — the framework re-runs the
selector (not the surrounding template expression) on machine transition.

```ts
${read(cart, c => c.itemCount)}                                  // text slot
${read(cart, c => c.contains(id) ? 'In cart' : 'Add to cart')}   // also text slot
```

### `each(items, fn)`

```ts
each(read(cart, c => c.items), (item, idx) => html`<li>${item.name}</li>`)
```

When `items` is a `ReadResult`, the list registers a `kind: 'list'` binding —
on the producing machine's next transition, the list re-renders as a single
`{ target: { kind: 'slot' }, op: 'html' }` patch if its shape changed.

### `when(cond, fn)` / `match(key, cases)`

Conditional rendering. Inactive branches are absent from the DOM (not
CSS-hidden) — the wrapping `<span data-slot data-branch>` stays as a
position marker.

```ts
${when(read(cart, c => !c.isEmpty), () => html`<a href="/checkout">Checkout</a>`)}

${match(read(checkout, c => c.state), {
  shipping: () => html`<div>...shipping fields...</div>`,
  payment:  () => html`<div>...payment fields...</div>`,
  complete: () => html`<div>...thanks!...</div>`,
})}
```

`match` is type-safe on case keys — `c.state` is typed as the literal union
of the machine's state names.

### `classList(spec)` / `styleList(spec)`

Directives that own an entire `class` / `style` attribute. Accept strings,
arrays, or `{ name: condition }` objects. Conditions can be `ReadResult`s,
making conditional classes/styles ergonomic without the compound-attribute
footgun.

```ts
${classList({
  'btn': true,
  'btn-primary': true,
  'is-active': read(cart, c => c.contains(id)),
})}
```

### `on(modifier, handler)`

The canonical event directive. The handler must be exactly one
`machine.send(...)` call. It runs once at server-render, captures the event
descriptor, and emits `data-event-<modifier>="<json>"` on the parent element.

### `defineDirective<TArg>({ name, apply })`

The mechanism `on`, `class:list`, and `style:list` are built on. `apply`
receives a context with `addAttribute(name, value)`, `modifier`, `arg`, and
the synthetic `elementId`. Future directives (form bindings, focus
management, etc.) plug in here.

## How a POST event flows

1. Browser fires `click` on a button with `data-event-click="..."`.
2. Delegated listener on `document.body` POSTs `{ machine, event }` to
   `/__events` with `X-Stator-Route: GET /cart`.
3. Server acquires the per-session async lock.
4. `SessionRuntime` selectively hydrates the route's `reads:` + the origin
   machine (transitively, via the subscriptions graph) — XState actors are
   rehydrated from snapshots in the `Store`.
5. Cross-machine subscriptions wired across the transient actors.
6. Route is rendered once to populate a request-scoped `RenderState` with
   `lastValue` baselines. HTML output discarded.
7. `runtime.processEvent` sends the event; subscription cascade fires;
   touched set populated.
8. `recompute(renderState, name, runtime)` for each touched machine emits
   patches in the wire shape documented in [`WIRE.md`](../../WIRE.md).
   Scope-subsumption drops descendant patches when a list/branch is
   replaced.
9. Touched machine snapshots persist to the Store.
10. Actors disposed. Lock released. Response sent.

## Tests

```bash
pnpm test              # full suite
pnpm test:watch        # watch mode
```
