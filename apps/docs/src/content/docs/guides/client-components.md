---
title: Client components
description: "Whole-file custom elements: StatorElement, use(), machine(), attrs, refs, and seeds."
sidebar:
  order: 4
---

A client component is a whole `.stator` file that compiles to a custom element running in the browser. Reach for one when state should stay [client-side](/concepts/server-client-boundary/) — instant, local, no round trip.

## Define an island

The root is a custom element; the `<script>` exports a name-matched `StatorElement` subclass:

```astro
<theme-toggle>
  <button on:click={toggle}>{read(theme, (t) => t.label)}</button>
</theme-toggle>

<script>
  const Theme = machine(
    { mode: 'light' },
    {
      on: { TOGGLE: (s) => { s.mode = s.mode === 'light' ? 'dark' : 'light' } },
      select: { label: (s) => s.mode === 'dark' ? '☾' : '☀' },
    },
  )

  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>
```

`<theme-toggle>` ↔ `ThemeToggle` must match.

## The server fence

An island file may open with a `---` fence, just like a server component — and it behaves exactly like one: it runs **on the server, per shell render**, and its bindings are in scope for the template. The `<script>` never sees it, in either direction — fence bindings are not client globals, and script members are not fence scope. Three regions, two worlds, one file:

```astro
---
// server: runs per shell render, never ships to the browser
import { TICKETS } from '../lib/rules.ts'
---
<reg-form>
  <select name="ticket">
    {TICKETS.map((t) => <option value={t}>{t}</option>)}
  </select>
  <button on:click={submit}>register</button>
</reg-form>

<script>
  // browser: hydrates onto the server-rendered shell
  export class RegForm extends StatorElement {
    submit() { /* … */ }
  }
</script>
```

The rule of thumb: **fences are for server work the island owns; per-use data stays props.** A catalog the form always renders, a computed constant, a DB query — fence. A per-visitor pre-fill value or a parent's `read()` — prop, because it varies by use site.

Because the fence runs per shell render, an island placed three times runs its fence three times, and a server re-render containing the island re-runs it — identical to a server component's frontmatter.

Two guardrails, both compile errors:

- **No `Stator.*` markers.** Island props are declared by `static attrs` (plus the open use-site tail), so `Stator.props` is rejected; `Stator.reads`, `Stator.request`, and `Stator.response` are route-only, as everywhere else.
- **No name collisions with `use()` fields.** A fence `const theme = …` alongside a `theme = use(Theme)` field is ambiguous by construction — the template couldn't tell the server value from the client machine — so the compiler makes you rename one.

## machine() and use()

`machine(context, behavior?)` defines a small client machine inline — plain data first, then `on` (events) and `select` (derived values). The split is what makes the types work: handlers and selectors see the context fully typed (`s.mode` above is a `string`), and `use(Def, seed?)` returns an instance whose context keys and selector results are real typed properties — `this.theme.mode` and `this.theme.label` type-check like anything else.

Events are typed in three tiers:

- **No `on` map** — a data-only machine accepts nothing: its context is set at construction and read for display, and `send` is a compile error.
- **An `on` map** — the event NAMES derive from its keys, so `send('TOGLE')` is a compile error. Payloads stay open.
- **A declared union** — `events: {} as E` mirrors `defineMachine` for full payload typing, with each handler narrowed to its own event:

```ts
const Checks = machine(
  { emailError: null as string | null },
  {
    events: {} as { type: 'CHECK'; value: string } | { type: 'RESET' },
    on: {
      CHECK: (s, e) => { s.emailError = emailError(e.value) }, // e.value: string
      RESET: (s) => { s.emailError = null },
    },
  },
)
```

### Eager vs deferred seeds

The optional seed sets initial context. Pass a **plain object** for static values, or a **thunk** when the seed reads `this.attrs` or the browser (these aren't available at field-construction; a thunk defers to connect):

```js
qty = use(Qty, () => ({ unitPrice: this.attrs.unitPrice }))
```

## this.attrs

Declare an attribute surface with a static coercer map. Author names are camelCase ↔ kebab DOM attrs; `Boolean` is a presence flag:

```js
static attrs = { unitPrice: Number, selected: Boolean }
// reads <… unit-price="12" selected>
```

## this.refs

Elements marked [`ref:name`](/guides/directives/#ref--element-handles) are reachable as `this.refs.name`.

## Lifecycle

Machine [actors](/concepts/state-machines/#definition-actor-instance) start on `connectedCallback` and stop on disconnect. Client-machine `read()`s and `effect()` subscribe to state and write the DOM natively — no client re-render.

## Islands are leaves

Islands are also the only code Stator bundles, and there is no bundler plugin to configure — by design. Tailwind, global CSS, images, and WASM are handled outside the bundler so they apply to the whole app, not just the island tier: see [Styling and assets](/guides/styling-and-assets/).

An island's markup is its own template — server-rendered content does not flow *through* it, and that's a deliberate boundary (like early Astro shipping without SSR: a known edge, owned). Four sanctioned channels cover composition with the server:

1. **Live attrs in.** Pass a `read()` as an island prop and the attribute becomes a live server binding. Declared attrs are observed: implement `${key}Changed(next)` and every patch lands there, coerced per your `static attrs` declaration.

   ```astro
   <stock-badge stock={read(inventory, (i) => String(i.stock[sku]))} />
   ```

   ```js
   static attrs = { stock: Number }
   stockChanged(next) { this.render(next) }
   ```

2. **`dispatch` out.** The one visible boundary crossing (below).

3. **Observing server-owned DOM.** For regions the server keeps fresh *outside* the island, plain platform tools (`querySelector`, `MutationObserver`) are legitimate — islands are custom elements. Prefer channel 1 when the data can arrive as an attr.

4. **Server-rendered sections (the adopt pattern).** Island templates may contain server-evaluated expressions — props-driven maps with nested JSX, even a full component render passed as a prop. The shell renders them per use; the class adopts them by querying:

   ```astro
   <div class="opts" ref:opts>
     {props.options.map((o) => <button class="opt" data-id={o.id}>{o.label}</button>)}
   </div>
   ```

   ```js
   connectedCallback() {
     super.connectedCallback()
     for (const b of this.querySelectorAll('.opt')) {
       b.addEventListener('click', () => this.pick(b.dataset.id))
     }
   }
   ```

   Note: `on:` directives and client-machine `read()`s don't reach inside these server sections — wiring happens in the class, which is the point of the pattern.

## Committing to the server

To change *server* state from an island, dispatch to a server machine:

```js
const result = await dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

`dispatch` resolves `{ ok, committed, patchCount }` — three different facts. `ok` is transport; **`committed`** is whether the event actually transitioned a machine (a guard-dropped event is `ok && !committed`); `patchCount` is how many patches landed on *this* page. Buttons that announce success should look at `committed`.
