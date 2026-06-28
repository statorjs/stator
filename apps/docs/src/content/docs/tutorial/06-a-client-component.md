---
title: 6. A client component
description: "Add client-only UI (the theme toggle) as a whole-file custom element."
sidebar:
  order: 6
---

Some state has no business on the server. A light/dark theme toggle should flip instantly, persist in the browser, and never cost a round trip. That's a **client component** — a whole `.stator` file that compiles to a custom element running in the browser.

## When state shouldn't touch the server

Adding to a cart is server state: it's authoritative, persisted, and shared with checkout. The theme is the opposite — it's local, instant, and per-device. Routing it through the server would put the network in the interaction loop for no benefit. The rule of thumb: **if losing the state on a server restart would be fine and a round trip would feel slow, it belongs on the client.**

## The whole-file element

Create `templates/theme-toggle.stator`. Unlike a server component, its root is a custom element (a lowercase, hyphenated tag) and it carries a `<script>`:

```astro
<theme-toggle>
  <button class="theme-toggle-btn" type="button" on:click={toggle} aria-label="Toggle theme">
    <span bind:text={theme.label}></span>
  </button>
</theme-toggle>

<script>
  const Theme = machine({
    mode: 'light',
    on: { TOGGLE: (s) => { s.mode = s.mode === 'light' ? 'dark' : 'light' } },
    select: { label: (s) => (s.mode === 'dark' ? '☾ Dark' : '☀ Light') },
  })

  export class ThemeToggle extends StatorElement {
    theme = use(Theme, () => ({ mode: readStoredTheme() }))

    toggle() {
      this.theme.send('TOGGLE')
      const mode = this.theme.mode
      document.documentElement.dataset.theme = mode
      try { localStorage.setItem('stator-theme', mode) } catch {}
    }
  }

  function readStoredTheme() {
    try { return localStorage.getItem('stator-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
  }
</script>

<style>
  .theme-toggle-btn {
    font: inherit;
    cursor: pointer;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
</style>
```

A client component can carry a scoped `<style>` just like a server one — same four-region `.stator` file, scoped the same way. That `<script>` is what makes this a client component. Its contents run in the browser — the machine imported (or defined) here is a **client** machine, decided entirely by the fact that it lives in the `<script>` rather than the frontmatter. The exported class name (`ThemeToggle`) must match the root tag (`<theme-toggle>`).

## machine({...})

`machine({...})` is the terse, in-`<script>` way to define a small client machine: an initial state shape, an `on` map of events, and `select` for derived values. Here `Theme` holds a `mode`, toggles it, and derives a `label`. It's the same machine model as the server's `defineMachine`, sized for a component.

## extends StatorElement + use()

`StatorElement` is the base class for a client component — it owns the actor lifecycle (start on connect, stop on disconnect), plus `this.attrs` and `this.refs`. You declare a machine instance as a class field with `use()`:

```js
theme = use(Theme, () => ({ mode: readStoredTheme() }))
```

`this.theme` is now a live instance: `this.theme.send('TOGGLE')` dispatches, and `this.theme.label` reads a selector — the same surface as a server machine, running locally.

### the hydration seed

The second argument to `use()` is the **seed** — the machine's initial context. It's a thunk (`() => ({ ... })`) here, not a plain object, for a specific reason: it reads from `localStorage` (and could read `this.attrs`), neither of which is available when the class field is first constructed. A thunk seed is deferred until the element connects to the DOM, by which point attributes and the browser environment are ready. **Use a thunk whenever the seed depends on `this.attrs` or the browser.**

## bind: and on: in a component

Inside a client component, the directives mirror the server:

- `on:click={toggle}` calls the component's `toggle()` method on click.
- `bind:text={theme.label}` keeps the `<span>`'s text in sync with the `label` selector — the client-side twin of `read()`. When `mode` flips, `label` recomputes and the span updates, with no server involvement.

Drop `<ThemeToggle />` into the layout header you built in [step 4](/tutorial/04-layouts/), so it appears on every page. In `templates/customer-layout.stator`:

```astro
---
import type { InstanceOf } from '@statorjs/stator/template'
import type CartMachine from '../machines/cart.ts'
import BaseLayout from './base-layout.stator'
import ThemeToggle from './theme-toggle.stator'

const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()
---
<BaseLayout>
  <div child="header" class="brand-bar">
    <a href="/" class="brand">Desksmith</a>
    <a href="/cart">Cart ({read(cart, c => c.itemCount)})</a>
    <ThemeToggle />
  </div>
  <children />
</BaseLayout>

<style>
  .brand-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    max-width: 60rem;
    margin: 0 auto;
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .brand { font-weight: 600; margin-right: auto; }
</style>
```

This is the complete file — the only change from step 4 is the added `ThemeToggle` import and `<ThemeToggle />` in the header; the `<style>` block stays. The toggle now flips the theme instantly, from any page, with no server round trip — and because the catalog and header use the theme tokens from `app.css`, the whole app switches palette.

## Avoiding a flash on load

There's one rough edge: on a reload, the page paints in light mode for a frame before the component connects and re-applies the stored dark theme. Fix it by applying the stored theme *before* the first paint, with a small inline script in `base-layout.stator`'s `<head>`:

```astro
<script is:inline>
  if (localStorage.getItem('stator-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
  }
</script>
```

`is:inline` tells Stator to emit this `<script>` verbatim rather than treat it as a client component — the opt-out you'd use for any literal inline script. It runs synchronously before the body renders, so there's no flash.

## What you built · next

A self-contained custom element with its own browser-side machine, persistence, and reactive binding — and not a single server round trip. In [step 7](/tutorial/07-persisting-state/) we go back to the server side and make the cart survive restarts.
