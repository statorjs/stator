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
  <button on:click={toggle}><span bind:text={theme.label}></span></button>
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

## machine() and use()

`machine(context, behavior?)` defines a small client machine inline — plain data first, then `on` (events) and `select` (derived values). The split is what makes the types work: handlers and selectors see the context fully typed (`s.mode` above is a `string`), and `use(Def, seed?)` returns an instance whose context keys and selector results are real typed properties — `this.theme.mode` and `this.theme.label` type-check like anything else. (A single combined bag is still accepted for compatibility, but its handlers see `any` — TypeScript cannot infer a context from the same object the handlers live in.)

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

Actors start on `connectedCallback` and stop on disconnect. `bind:` directives and `effect()` subscribe to state and write the DOM natively — no client re-render.

## Islands are leaves

An island's markup is its own template — server-rendered content does not
flow *through* it, and that's a deliberate v1 boundary (like early Astro
shipping without SSR: a known edge, owned). Three sanctioned channels cover
composition with the server:

1. **Live attrs in.** Pass a `read()` as an island prop and the attribute
   becomes a live server binding. Declared attrs are observed: implement
   `${key}Changed(next)` and every patch lands there, coerced per your
   `static attrs` declaration.

   ```astro
   <stock-badge stock={read(inventory, (i) => String(i.stock[sku]))} />
   ```

   ```js
   static attrs = { stock: Number }
   stockChanged(next) { this.render(next) }
   ```

2. **`dispatch` out.** The one visible boundary crossing (below).

3. **Observing server-owned DOM.** For regions the server keeps fresh
   *outside* the island, plain platform tools (`querySelector`,
   `MutationObserver`) are legitimate — islands are custom elements.
   Prefer channel 1 when the data can arrive as an attr.

4. **Server-rendered sections (the hydrate pattern).** Island templates may
   contain server-evaluated expressions — props-driven maps with nested JSX,
   even a full component render passed as a prop. The shell renders them per
   use; the class hydrates by querying:

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

   Note: `on:`/`bind:` directives don't reach inside these server sections —
   wiring happens in the class, which is the point of the pattern.

## Committing to the server

To change *server* state from an island, dispatch to a server machine:

```js
const result = await dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

`dispatch` resolves `{ ok, committed, patchCount }` — three different facts.
`ok` is transport; **`committed`** is whether the event actually transitioned
a machine (a guard-dropped event is `ok && !committed`); `patchCount` is how
many patches landed on *this* page. Buttons that announce success should look
at `committed`.
