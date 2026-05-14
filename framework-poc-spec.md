# State-Machine-First Web Framework — POC Specification

## Document Purpose

This is the working specification for a proof-of-concept (POC) implementation of a new server-canonical web framework built around composable state machines. It captures the architectural decisions, rationale, API surface, and implementation plan derived from extended design discussion. It is intended as primary context for the Claude CLI agent that will build the POC, and as a reference for ongoing design decisions.

The framework does not yet have a name. Throughout this document it is referred to as "the framework."

---

## Vision

The framework is a server-canonical web framework for JavaScript/TypeScript where **business logic lives in composable state machines that have no awareness of the UI**, and the UI layer is a thin, fine-grained renderer that binds state machine outputs to DOM positions.

The goal is to make the easy path the architecturally sound path: separation of concerns by default, testability without virtual DOMs, refactor safety because logic and rendering can change independently, and operational simplicity because state lives in well-defined places with explicit boundaries.

A secondary but deliberate goal is **legibility for LLM agents**. State machines as the unit of logic produce small, self-describing files; strict architectural rules produce schemas that can be exported as agent context; explicit imports and named primitives mean LLMs can reason about code without needing to crawl the entire codebase.

---

## Motivation: Problems With the Status Quo

Contemporary frontend frameworks — React most prominently, but most of the field by varying degrees — have made state and UI components mutually load-bearing. Logic lives in hooks attached to components, providers attached to component trees, and increasingly (in React Server Components) in components themselves whose execution location is determined by import-graph reachability. This produces:

- **Testability that requires a virtual DOM** because logic can't be exercised independently of rendering.
- **Refactors that cascade across the component tree** because moving logic means tracing every hook call, every provider, every prop drill.
- **Invisible security boundaries** because RSC's server/client split is determined by bundling rather than declaration, leading to env var leaks, accidental server actions, and security incidents that require commit-history archaeology to understand.
- **Auto-tracked reactive dependencies that hide bugs** — conditional reads inside signal or effect bodies can silently fail to subscribe to dependencies that the developer reasonably expected to be tracked.
- **No clear story for held server state** in lightweight server-rendering frameworks like HTMX, leaving developers to invent ad-hoc patterns.
- **Coupling that LLM agents struggle with** because reasoning about any single file requires loading its transitive context, which often doesn't fit in a context window.

This framework is a deliberate response to each of these failure modes.

---

## Core Principles

These principles are load-bearing for the architecture. Departures from them require explicit justification.

1. **State machines are the unit of business logic.** Not components, not hooks, not stores. Machines are named, schemed, and composable through events.

2. **Server-canonical state.** Authoritative state lives on the server. The client is a thin renderer that receives DOM patches and emits events. A parallel "client plane" exists for genuinely local ephemeral state but is clearly bounded.

3. **The server/client boundary is spatial and mandatory.** A machine is a server machine or a client machine at definition time. There is no inference, no bundling-driven location, no fuzzy boundary. Module paths and the type system enforce this.

4. **Reactivity is unidirectional: signals out, events in.** Templates read state; events change state. No two-way binding. No mutation through bindings.

5. **Explicit dependencies over auto-tracking.** Where dependencies must be declared (machine-to-machine relationships, derived computations), they are named. Where they must be tracked (template slot reads), tracking happens at compile time over a small, well-scoped surface — not via runtime proxies over arbitrary code.

6. **No inline machines.** Machines are global named entities, registered through file conventions, exposed in the schema. The single exception is `defineLocalMachine` in template frontmatter (V1 feature), which is explicitly file-scoped, ephemeral, client-only, and out of schema.

7. **Schema completeness as a feature.** Every machine, template, event, and inter-machine relationship is statically introspectable. A `framework schema` CLI exports this for LLM agents and tooling consumption.

8. **Treat LLMs like any other consumer.** The framework ships excellent CLI tooling and clear README documentation. It does not ship MCP servers, embedded models, or natural-language interfaces.

9. **Adapter pattern for deployment concerns.** The framework's default experience is zero-infrastructure (in-memory store, HTTP transport). Adapters swap in Redis, KV, alternate transports, build targets without changing user code.

10. **Build for the long-term shape, even in the POC.** Decisions about extensibility (directive mechanism, segmented imports, schema completeness) are made upfront. Deferring them is a path to accreted special-cases that are painful to extract later.

---

## Architecture Overview

### State Lives in Exactly Two Places

**Server machines** hold authoritative business state. They are persisted to a configurable store (in-memory for POC; Redis/KV/Postgres via adapter for V1+). Machine state must be plain serializable data. Each machine instance is identified by `(machineName, sessionId)` for session-lifecycle machines, or just `machineName` for app-lifecycle machines.

**Client signals and client machines** hold ephemeral browser-local state — input drafts, dropdown open/closed, theme preference, anything that wouldn't survive a server restart and shouldn't need to. In V1, client machines are file-scoped and defined in template frontmatter via `defineLocalMachine`. In the POC, the example app does not need any client state and this layer is deferred.

State is **immutable within a render frame**. A single event's handling produces one consistent state transition. Rendering reads against an immutable snapshot. State mutations only happen between events, never during render.

### Reactivity Has No Server Runtime

On the server, there is no reactive runtime. The compile-time analysis of templates produces a static map from slots to the state fields they read. When a machine processes an event and its state changes:

1. The framework looks up affected slots in O(1) via the static map.
2. Affected slots are re-evaluated against the new state.
3. The new values are diffed against the previously-sent values per session.
4. Changed slots are emitted as wire patches.

There is no reactive graph, no subscription bookkeeping, no event log. Reactivity is a compile-time property of templates plus a runtime O(1) lookup.

On the client, reactivity exists in the V1 client plane as explicit-dependency derived computations (no auto-tracking). The POC does not include this.

### Frontend/Backend Split

Sharp and visible. Business logic, validation, authorization, persistence, and rendering live on the server. The client receives patches and emits events. The client has minimal application code — the framework's client runtime plus whatever client machines exist for ephemeral concerns.

Security boundaries are the event protocol. Every event arriving at the server is schema-validated at the wire edge before reaching a machine. Authorization is a property of machines themselves.

### Wire Protocol

Two tiers:

**Default tier (quiet):** Events POST to the server. The response carries the resulting slot patches as JSON. No persistent connection. This is what the POC implements. It handles the vast majority of CRUD-style use cases.

**Live tier (V1+, opt-in):** Adds an SSE channel for server-initiated updates (collaborative state, background jobs, timers). Events still POST; updates flow over SSE asynchronously. Not in POC scope.

WebSockets are deliberately not the default. SSE+POST is operationally simpler and works through more network configurations.

### Templates

Templates are pure functions of their declared machine and parameter inputs. The same template can be rendered as part of a full page, returned as a partial in response to an event, or have its individual slots patched in place — all without modification. The framework determines the appropriate response shape based on what the event produced and what changed.

In the POC, templates are tagged template literals in `.ts` files. In V1, templates become single-file components in a custom format with frontmatter, JSX-flavored bodies, and scoped styles — but the runtime is the same.

---

## Key Decisions and Rationale

### Server-Canonical, Not Client-Canonical

**Decision:** State lives on the server. Client is a thin renderer.

**Why:** "Render where state lives" is the rule that eliminates an entire class of problems — state synchronization, hydration mismatches, bundle size pressure, offline-vs-online code paths. LiveView and Hotwire have proven the model at scale. The cost is network latency on interactions, which is acceptable for the target audience (business applications, B2B SaaS, admin tools) and unacceptable for the non-target (high-interaction consumer apps, games, creative tools).

### Server Boundary Is Spatial, Not Inferred

**Decision:** A machine is declared as `server` or `client` at definition time. The boundary is visible in file paths and type declarations.

**Why:** React Server Components' invisible boundary is the failure mode we're explicitly avoiding. Spatial boundaries are easy to enforce (file-system layout, package subpath imports, ESLint rules), easy to inspect (read a file, see where it runs), and impossible to be wrong about.

### XState v5 for the POC, Custom Machine Implementation for V1

**Decision:** Wrap XState v5 with a framework-specific `defineMachine` API in the POC. Reconsider for V1.

**Why:** XState v5 is mature, well-typed, and provides everything we need (states, transitions, guards, actions, context, actors). Reinventing it for the POC is wasted effort. For V1, we may want a custom implementation to control the surface area more tightly, integrate with the schema export, and remove XState concepts we don't use.

### Machine Discovery Is File-Based With Explicit Dependencies

**Decision:** Server machines live in `/machines/`, one default export per file. Dependencies are declared explicitly via a `reads:` array. The framework imports all files in `/machines/` at startup, validates dependencies, builds a topological order, and instantiates.

**Why:** Convention-based discovery (file = name) is zero boilerplate. Explicit dependency declarations are critical for:
- Schema completeness (LLM agents see machine relationships at a glance)
- Static cycle detection (cycles become build errors with clear messages)
- Lint enforcement of declared-vs-actual reads

Decorators were considered and rejected (require parsing every file before the runtime can use them). Implicit dependencies via guard/action scanning were considered and rejected (reduces schema legibility).

### `reads` Means "Synchronous Access," Not "Subscribe"

**Decision:** Declaring `reads: [CartMachine]` means CheckoutMachine can call `cartInstance.getSnapshot()` and access selectors. It does NOT mean CheckoutMachine reactively re-evaluates when CartMachine changes. Cross-machine reactivity happens through events, not subscriptions.

**Why:** Preserves the rule that "the only thing that changes state is an event." Machines remain pure event processors. Reactive subscriptions are a template-only concept.

### Templates Use Explicit Helpers (`read`, `each`, `on`) Via Import

**Decision:** Template helpers are imported from `framework/template`. No globals.

**Why:** Globals make tooling harder (ambient declarations drift), schema completeness suffers (imports are part of a file's self-description), and the import line cleanly signals what surface the file uses. An LLM with the file in context sees imports first.

### Directive Mechanism as a Primitive From Day One

**Decision:** `on` is implemented as the first user of a `defineDirective` API. The infrastructure ships with the POC even though `on` is the only built-in directive initially.

**Why:** Astro's experience shows that growing directives one-by-one without a primitive produces a parser littered with special cases that's painful to extract later. The cost of building the mechanism upfront (~50 LOC) is small. The cost of retrofitting it is enormous.

### Tagged Template Literals for POC, SFC With JSX-Flavored Body for V1

**Decision:** POC uses `html\`...\`` tagged templates in `.ts` files. V1 introduces a custom file format (`.framework` or similar) with frontmatter, JSX-flavored body, and scoped styles.

**Why:** Tagged templates require no compiler — we can prove the runtime model first. The SFC format is purely additive: it's a different syntax targeting the same runtime primitives. Building the compiler is a contained V1 project that doesn't block the runtime work.

### `read` Not `bind`

**Decision:** Template state reads are called `read(machine, selector)`. The verb `bind` is rejected.

**Why:** `bind` implies two-way binding (Svelte's `bind:value`, Vue's `v-model`). We explicitly reject two-way binding. The verb should not suggest the thing we're against. `read` is honest about what's happening: the template reads state, sends events.

### In-Memory Store for POC, Adapter Pattern for V1

**Decision:** POC ships with an in-memory state store. V1 introduces an adapter API (modeled on Astro's adapter pattern) for swapping in Redis, KV, Postgres, alternate transports, alternate build targets.

**Why:** Zero-infrastructure default is critical for the new-project experience. The adapter contract is small (`get`, `set`, `delete` on serialized state) because machine state is plain serializable data — a property we're getting for free from our other architectural choices.

### No Auto-Tracking; Compile-Time Slot Analysis Instead

**Decision:** Reactive dependencies for templates are determined at compile time by analyzing `read()` calls. In the POC, dependency tracking happens at render time via the explicit selector function passed to `read`.

**Why:** Auto-tracking (Solid, Vue, MobX, Preact, the TC39 proposal) has the conditional-read footgun — `if (a()) { return b() }` only tracks `a` until the condition flips, leading to surprising missed updates. Explicit reads through `read(machine, selector)` mean every dependency is visible at the call site. The minor relaxation: within the selector function, reads on the passed machine are auto-tracked, but the scope is small and the boundary is the function signature.

---

## POC Scope

The POC's job is to prove the **runtime model**: machines + templates + slot-level patching + event routing + in-memory session state, working end-to-end against a real example app.

### In Scope

- `defineMachine` API wrapping XState v5
- File-based machine discovery from `/machines/` directory
- Explicit `reads:` declarations with dependency graph validation
- In-memory session store mapping `sessionId → { machineName → instance }`
- App-lifecycle machines (instantiated once at startup) and session-lifecycle machines (instantiated per session)
- `html` tagged template literal with `read`, `each` bindings
- `defineDirective` API with `on` as the first directive
- Slot tracking: every `read` call produces an addressable DOM slot
- Per-session record of last-sent slot values
- HTTP layer: initial page render endpoint, event POST endpoint returning patches
- Client runtime (<200 LOC): apply slot patches, dispatch events, handle session cookie
- Example app: cart-based ecommerce with products page, cart page, checkout flow
- Basic styling via a single global CSS file (scoped styles come in V1)

### Explicitly Out of Scope for POC

- Compile-time slot analysis (use runtime tracking; defer compiler)
- Single-file component format (use `.ts` files with tagged templates)
- Scoped styles (use global CSS)
- Local client machines / client plane (example app doesn't need them)
- Adapter system (in-memory only)
- SSE / live updates (request-response only)
- Schema CLI / `framework schema` command (V1)
- Dev tools (machine inspector, slot inspector, event flow trace)
- Hot reload
- Production build, bundling, optimization
- Authentication
- Real database persistence
- Multiple environments
- Web Components / shadow DOM (V1+)
- Routing framework (use simple path-based dispatch)
- Form handling abstractions

---

## API Surface

### Server Machine Definition

```ts
// /machines/cart.ts
import { defineMachine } from 'framework/server'

type CartItem = {
  productId: string
  quantity: number
  unitPrice: number
}

type CartContext = {
  items: CartItem[]
}

type CartEvent =
  | { type: 'ADD_ITEM'; productId: string; unitPrice: number }
  | { type: 'REMOVE_ITEM'; productId: string }
  | { type: 'SET_QUANTITY'; productId: string; quantity: number }
  | { type: 'CLEAR' }

export default defineMachine({
  name: 'CartMachine',
  lifecycle: 'session',
  reads: [],
  emits: ['ITEM_ADDED', 'ITEM_REMOVED', 'CART_CLEARED'],

  context: { items: [] } as CartContext,

  initial: 'idle',
  states: {
    idle: {
      on: {
        ADD_ITEM: {
          actions: 'addItem',
          emit: 'ITEM_ADDED',
        },
        REMOVE_ITEM: {
          actions: 'removeItem',
          emit: 'ITEM_REMOVED',
        },
        SET_QUANTITY: {
          actions: 'setQuantity',
          guard: 'quantityIsValid',
        },
        CLEAR: {
          actions: 'clearCart',
          emit: 'CART_CLEARED',
        },
      },
    },
  },

  actions: {
    addItem: (ctx, event) => {
      const existing = ctx.items.find(i => i.productId === event.productId)
      if (existing) {
        existing.quantity += 1
      } else {
        ctx.items.push({
          productId: event.productId,
          quantity: 1,
          unitPrice: event.unitPrice,
        })
      }
    },
    removeItem: (ctx, event) => {
      ctx.items = ctx.items.filter(i => i.productId !== event.productId)
    },
    setQuantity: (ctx, event) => {
      const item = ctx.items.find(i => i.productId === event.productId)
      if (item) item.quantity = event.quantity
    },
    clearCart: (ctx) => {
      ctx.items = []
    },
  },

  guards: {
    quantityIsValid: (_ctx, event) => event.quantity > 0 && event.quantity <= 99,
  },

  selectors: {
    itemCount: (ctx) => ctx.items.reduce((sum, i) => sum + i.quantity, 0),
    total: (ctx) => ctx.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
    contains: (ctx) => (productId: string) =>
      ctx.items.some(i => i.productId === productId),
    isEmpty: (ctx) => ctx.items.length === 0,
  },
})
```

### App-Lifecycle Machine

```ts
// /machines/products.ts
import { defineMachine } from 'framework/server'

type Product = {
  id: string
  name: string
  price: number
  description: string
}

const SEED_PRODUCTS: Product[] = [
  { id: 'p1', name: 'Notebook', price: 12.00, description: 'A6, dotted, 96 pages' },
  { id: 'p2', name: 'Pen', price: 3.50, description: 'Fine tip, black ink' },
  { id: 'p3', name: 'Desk Lamp', price: 45.00, description: 'Adjustable, warm white' },
  { id: 'p4', name: 'Coffee Mug', price: 14.00, description: 'Ceramic, 12 oz' },
]

export default defineMachine({
  name: 'ProductsMachine',
  lifecycle: 'app',
  reads: [],
  emits: [],

  context: { products: SEED_PRODUCTS },
  initial: 'ready',
  states: { ready: {} },

  selectors: {
    all: (ctx) => ctx.products,
    byId: (ctx) => (id: string) => ctx.products.find(p => p.id === id),
  },
})
```

### Template Definition

```ts
// /templates/product-list.ts
import { html, read, each, on } from 'framework/template'
import ProductsMachine from '../machines/products'
import CartMachine from '../machines/cart'

export default function productList(
  products: InstanceOf<typeof ProductsMachine>,
  cart: InstanceOf<typeof CartMachine>,
) {
  return html`
    <section class="products">
      <h1>Products</h1>
      <ul class="product-grid">
        ${each(read(products, p => p.all), (product) => html`
          <li class="product-card" data-product-id="${product.id}">
            <h3>${product.name}</h3>
            <p class="description">${product.description}</p>
            <p class="price">$${product.price.toFixed(2)}</p>
            <button
              ${on('click', () =>
                cart.send({
                  type: 'ADD_ITEM',
                  productId: product.id,
                  unitPrice: product.price,
                })
              )}
              class="${read(cart, c => c.contains(product.id)) ? 'is-in-cart' : ''}"
            >
              ${read(cart, c => c.contains(product.id)) ? 'In cart' : 'Add to cart'}
            </button>
          </li>
        `)}
      </ul>
    </section>
  `
}
```

### Layout Template

```ts
// /templates/layout.ts
import { html, read } from 'framework/template'
import CartMachine from '../machines/cart'

export default function layout(
  cart: InstanceOf<typeof CartMachine>,
  body: HtmlFragment,
) {
  return html`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Shop</title>
        <link rel="stylesheet" href="/static/app.css">
      </head>
      <body>
        <header>
          <a href="/">Shop</a>
          <a href="/cart" class="cart-link">
            Cart (${read(cart, c => c.itemCount)})
          </a>
        </header>
        <main>${body}</main>
        <script src="/static/client.js"></script>
      </body>
    </html>
  `
}
```

### Directive Definition

```ts
// framework/template/directives/core.ts
export interface DirectiveContext<TArg> {
  element: ElementHandle
  modifier: string
  arg: TArg
  registerCleanup(fn: () => void): void
}

export interface DirectiveDefinition<TArg = unknown> {
  name: string
  apply(ctx: DirectiveContext<TArg>): void
}

export function defineDirective<TArg>(
  def: DirectiveDefinition<TArg>
): Directive<TArg> {
  return { ...def, __directive: true as const }
}
```

```ts
// framework/template/directives/on.ts
import { defineDirective } from './core'

export const on = defineDirective<EventListener>({
  name: 'on',
  apply({ element, modifier, arg, registerCleanup }) {
    const handler = arg as EventListener
    element.addEventListener(modifier, handler)
    registerCleanup(() => element.removeEventListener(modifier, handler))
  },
})
```

### Wire Protocol — Patch Response

When an event POST is processed, the server returns a JSON response with the slot patches:

```json
{
  "patches": [
    { "slot": "s0", "value": "1" },
    { "slot": "s7", "value": "In cart" },
    { "slot": "s8", "attr": "class", "value": "is-in-cart" }
  ]
}
```

Each patch has:
- `slot`: the slot identifier in the DOM (`<span data-slot="s0">...</span>`)
- `value`: the new text/attribute value
- `attr` (optional): if present, patches an attribute on the slot's parent element instead of the slot's text content

### Wire Protocol — Event POST

Client sends:

```json
{
  "machine": "CartMachine",
  "event": { "type": "ADD_ITEM", "productId": "p1", "unitPrice": 12.00 }
}
```

Session is identified via cookie. Server routes to the named machine, processes the event, returns the patch response.

### App Entry Point

```ts
// /app.ts
import { createApp } from 'framework/server'
import layout from './templates/layout'
import productListTemplate from './templates/product-list'
import cartPageTemplate from './templates/cart-page'

const app = createApp({
  machinesDir: './machines',
  routes: {
    '/': ({ products, cart }) => layout(cart, productListTemplate(products, cart)),
    '/cart': ({ cart, products }) => layout(cart, cartPageTemplate(cart, products)),
  },
})

app.listen(3000)
```

The `createApp` function:
1. Imports all files from `machinesDir` (glob `**/*.ts`)
2. Validates each file's default export is a `defineMachine` result
3. Builds the dependency graph from `reads:` declarations
4. Detects cycles, fails fast if found
5. Topologically sorts and instantiates app-lifecycle machines
6. Returns an app object with `listen()` that starts the HTTP server

---

## Directory Structure

```
/framework-poc
  /src
    /framework
      /server
        index.ts            # defineMachine, createApp exports
        define-machine.ts   # XState v5 wrapper
        machine-store.ts    # in-memory session-keyed machine instances
        discovery.ts        # glob-based machine discovery, dep graph
        render.ts           # template rendering, slot tracking
        http.ts             # HTTP routes for initial render and events
      /template
        index.ts            # html, read, each exports
        directives/
          index.ts          # defineDirective, on exports
          core.ts           # DirectiveDefinition, defineDirective
          on.ts             # the `on` directive
        html.ts             # tagged template literal implementation
        bindings.ts         # read, each implementations
        slot-tracker.ts     # per-render slot ID generation and tracking
      /client
        runtime.ts          # client-side: apply patches, dispatch events
    /example
      /machines
        cart.ts
        products.ts
        checkout.ts
      /templates
        layout.ts
        product-list.ts
        cart-page.ts
        checkout-page.ts
      /static
        app.css
      app.ts                # createApp call, route definitions
  package.json
  tsconfig.json
  README.md
```

---

## Implementation Plan

The implementation is staged so each step is independently demoable and each builds on the previous. If only steps 1–4 are completed, the result is still a working demo of the core model.

### Step 1: Project Scaffolding

- Initialize Node + TypeScript project (target: ES2022, module: ESNext, strict)
- Set up package.json with subpath exports for `framework/server`, `framework/template`, `framework/client`
- Install XState v5
- Choose HTTP layer: Fastify is preferred (well-typed, fast, modern), Express acceptable as fallback
- Establish import boundaries via tsconfig paths or workspace structure

**Verification:** `npm run typecheck` passes on an empty stub of each module.

### Step 2: Machine Definition + In-Memory Store

- Implement `defineMachine` as a thin wrapper around XState v5's `createMachine`/`createActor`
- The wrapper attaches framework metadata: `name`, `lifecycle`, `reads`, `emits`, `selectors`
- Implement `MachineStore`: in-memory `Map<sessionId, Map<machineName, ActorInstance>>` plus a separate `Map<machineName, ActorInstance>` for app-lifecycle machines
- Implement machine discovery: `discoverMachines(dir)` returns an ordered list with cycle detection
- Implement instantiation: app-lifecycle machines start at server boot; session-lifecycle machines start on first access for a session

**Verification:** Unit test that defines two server machines with a dependency, discovers them, instantiates correctly, and can send events to a session-lifecycle machine and read its updated state.

### Step 3: Template Engine With Slot Tracking

- Implement `html` tagged template that produces an HTML string plus a slot map
- Implement `read(machine, selector)` that:
  - Records a slot at this position
  - Records that the slot depends on the given machine and selector
  - Evaluates the selector against current state to produce the rendered value
  - Wraps the value in a `<span data-slot="sN">` marker (for text positions) or returns a special token (for attribute positions, handled by the surrounding `html` template)
- Implement `each(iterable, fn)` that produces a list of rendered fragments, each with their own nested slot scope
- Implement `defineDirective` and the `on` directive
- Integrate with the slot tracker: directives can register event handlers that map to event dispatches

**Verification:** Render a template that reads from a machine, capture the HTML output and slot map. Mutate the machine state, recompute affected slots, verify the diff against the previous output.

### Step 4: HTTP Layer

- Initial render endpoint: GET any registered route → render the route's template, persist the slot map per session, return HTML with embedded session cookie
- Event endpoint: POST `/__events` → identify session via cookie, route event to named machine, process transition, recompute affected slots, diff against per-session record, return JSON patches
- Static file serving for client runtime and CSS

**Verification:** Manual test: open `/`, see the product list. Click "Add to cart" (handled by client runtime — see step 5). Observe the request in DevTools, see the patch response, see the DOM update.

### Step 5: Client Runtime

- Small script (<200 LOC) loaded by the layout template
- On page load: scan DOM for elements with `data-event` attributes, attach listeners that POST the event payload to `/__events`
- On patch response: iterate patches, find `[data-slot="..."]` elements, apply text or attribute updates
- Handles the session cookie automatically (browser handles this; just need to ensure cookie is set on initial render)

**Verification:** End-to-end click test on the products page produces the expected DOM update without a full reload.

### Step 6: Example App

- Define `CartMachine`, `ProductsMachine`, `CheckoutMachine`
- Write templates: `layout`, `product-list`, `cart-page`, `checkout-page` (with multi-step checkout state machine displayed)
- Write a small `app.css` for basic styling
- Wire up routes in `app.ts`

**Verification:** Manual test the full flow:
- Visit `/`, see products
- Click "Add to cart" on a product, see header cart count update and button state change
- Visit `/cart`, see cart contents
- Navigate to `/checkout`, walk through the checkout state machine transitions
- "Complete" the checkout, see the thank-you state

### Step 7: README and Cleanup

- Document the framework's concepts at a level that someone new can grasp the model
- Document the example app
- Note known limitations and what's deferred to V1

---

## Acceptance Criteria for POC

The POC is considered successful if:

1. The example app runs locally with `npm start` and demonstrates the full cart-and-checkout flow
2. Adding an item to the cart updates the header cart count and the product card button state via slot patches, with no full page reload
3. The cart state survives navigation between pages within a session
4. The checkout machine demonstrates multi-state transitions with guards
5. Machine and template code can be read independently and understood without cross-reference
6. The framework's source code is small enough to be read in one sitting (target: under 2000 LOC for the framework itself, excluding example app)
7. A new template can be added to the example app without touching any framework code

---

## Open Questions Deferred to V1

These are decisions we've discussed but don't need to make before the POC works:

- **Final template file format** (`.framework` extension or `.tmpl` or something else)
- **Compiler architecture** (custom parser, fork of Astro's, or fork of Svelte's)
- **Adapter API specifics** (interface for store, transport, build target)
- **Schema CLI design** (filter flags, output format options)
- **Routing system** (currently the POC uses simple path-based dispatch; V1 needs a real router)
- **Form abstractions** (probably a `form` directive or a form machine pattern)
- **SSE transport** for live updates
- **Custom machine implementation** to replace XState dependency
- **Editor tooling / language server**
- **Hot reload strategy**

---

## A Note on LLM-Assisted Development

This framework's architecture is deliberately friendly to LLM-assisted development. Specifically:

- **State machines are self-documenting.** A machine file declares its name, lifecycle, dependencies, events, states, and transitions in one place. An LLM reading the file has complete information about that piece of business logic.
- **Templates declare their inputs.** A template function's parameters tell you exactly what machines and data flow in. There is no implicit context, provider chain, or hook system to trace.
- **Directionality is explicit.** `read` reads, `send` dispatches events, `on` attaches handlers. Three verbs. An LLM seeing them in a file understands the data flow without needing to know framework internals.
- **Explicit imports.** Every primitive a file uses is in the import block. No globals, no ambient declarations.

When working on this codebase with an LLM:
- Provide the relevant machine file(s) plus the template(s) that read from them — usually fits in a small context window
- The framework runtime itself rarely needs to be in context once the agent understands the model
- Schema export (V1) will make this even cleaner — a single `framework schema --from CheckoutMachine` command produces optimal context for a checkout-related task

---

## Glossary

- **Machine** — a state machine defined via `defineMachine`. Holds state, processes events, exposes selectors. Always named, always file-located.
- **Server machine** — a machine that runs on the server, holds canonical state, persisted via the store.
- **Client machine** — a machine that runs on the client, holds ephemeral local state. Only `defineLocalMachine` in V1 frontmatter; not in POC.
- **App-lifecycle machine** — one instance per server, instantiated at startup, shared across all sessions.
- **Session-lifecycle machine** — one instance per session, instantiated on first access, persists for the session's lifetime.
- **Template** — a function that takes machines and parameters and returns rendered HTML with embedded slots.
- **Slot** — a position in rendered HTML that is bound to a state read and can be patched. Identified by `data-slot` attribute or position.
- **Read** — a template's access to machine state via the `read(machine, selector)` helper. Registers a slot and its dependency.
- **Directive** — a registered template extension that processes attributes in element position. `on:click` is the canonical example; `defineDirective` is the API.
- **Patch** — a wire message describing a single DOM update: which slot, what new value, optionally what attribute.
- **Adapter** — (V1) a pluggable module that swaps in alternative implementations for state storage, transport, or build target.
- **Schema** — (V1) a build-time export describing all machines, templates, events, and their relationships. Consumed by LLM tooling and documentation generators.
