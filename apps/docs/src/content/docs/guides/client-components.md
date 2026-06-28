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
  const Theme = machine({
    mode: 'light',
    on: { TOGGLE: (s) => { s.mode = s.mode === 'light' ? 'dark' : 'light' } },
    select: { label: (s) => s.mode === 'dark' ? '☾' : '☀' },
  })

  export class ThemeToggle extends StatorElement {
    theme = use(Theme)
    toggle() { this.theme.send('TOGGLE') }
  }
</script>
```

`<theme-toggle>` ↔ `ThemeToggle` must match.

## machine() and use()

`machine({...})` defines a small client machine inline (`on` for events, `select` for derived values). `use(Def, seed?)` instantiates it as a class field — `this.theme.send(...)` and `this.theme.label` mirror a server machine.

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

## Committing to the server

To change *server* state from an island, dispatch to a server machine:

```js
dispatch(CartMachine, { type: 'ADD_ITEM', productId: id })
```

:::caution[Phase 3b]
Client `dispatch` over `/__events` is partly behind the in-progress client plane. Client islands using only portable client machines work today; dispatch-to-server is still being finished. See [Dispatching events](/guides/dispatching-events/).
:::
