---
title: The server/client boundary
description: "Import location decides where a machine runs — and the compiler enforces it."
sidebar:
  order: 2
---

The hardest question in a full-stack framework is "where does this code run?" Stator answers it with one rule you can see in the source, and a compiler that holds you to it.

## One mechanism: import location

Where a machine runs is decided by **where you import it**:

- Imported in a `.stator` file's **frontmatter** (the `---` fences) → runs on the **server**.
- Imported in a `.stator` file's **`<script>`** → runs in the **browser**.

```astro
---
import CartMachine from '../machines/cart.ts'   // ← server
const [cart] = Stator.reads([CartMachine])
---
<!-- … -->
<script>
  import { Theme } from './theme.ts'            // ← browser
</script>
```

That's the entire mechanism. The import site *is* the declaration of where the code lives.

### Running a machine, or addressing one

A `<script>` imports a machine for one of two reasons, and what you do with the import says which:

```astro
<script>
  import Draft from '../lib/draft.ts'        // passed to use() → runs in the browser
  import Cart from '../machines/cart.ts'     // only dispatched to → stays on the server

  export class CartForm extends StatorElement {
    draft = use(Draft)
    submit() { void dispatch(Cart, { type: 'ADD', sku: this.draft.sku }) }
  }
</script>
```

- **`use(Machine)`** runs the machine in the island. Its code is bundled for the browser.
- **`dispatch(Machine, event)`** addresses a machine that lives on the server. The import becomes its `{ name }` in the bundle, and the machine's code never ships.

Nothing marks a file as client or server, and no pragma says which a machine is. The same definition can be registered on the server, run in an island, and tested in Node.

The build reads this from the script, by following the import:

| The script… | The bundle gets |
|---|---|
| passes the import to `use()`, directly or through a `const` alias | the machine's code |
| calls the import, as with a machine factory (`const Menu = makeToggle('Menu')`) | the module's code |
| reads a named export, or a property of the machine other than `name` | the module's code |
| only passes the import to `dispatch()`, or reads its `name` | `{ name }` |
| does anything else with it (hands it to another function, puts it in an array, re-exports it) | a build error |

The last row is deliberate. A use the build can't place is refused rather than guessed at, so a machine never ships by accident and never arrives as a stub where its code was needed. Import a machine module directly in the script that uses it; a barrel file that re-exports machines is refused for the same reason.

### The explicit anti-goal

Stator deliberately avoids the alternatives:

- No `"use client"` / `"use server"` directives.
- No file coloring (a file isn't "a client file" or "a server file").
- No viral transitivity, where one annotation forces annotations up the import graph.

These are the things that make the React Server Components boundary hard to hold in your head. Import location is local, visible, and non-viral — you can answer "where does this run?" by looking at one import, never the whole graph.

## The definition is location-agnostic

A machine definition has no inherent side. The same `defineMachine(...)` can run on the server in one place and in the browser in another; nothing about the definition changes. Every machine imports `defineMachine` from the same place, `@statorjs/stator/machine`, the engine on its own; there is no client version and no server version to choose between. What a machine an island runs can't do is import `@statorjs/stator/server`, which is server code. This is what makes a machine's selectors **isomorphic** — the `total` selector you `read()` on the server is the same function a client island `read()`s locally. You author the logic once and place it where each use needs it.

## Portable vs server-pinned at the use site

Placement is your decision; **legality** is the compiler's. A [portable](/concepts/state-machines/#capabilities) machine (no cross-machine reads, no server-only capability) can go in a `<script>`. A server-pinned one cannot — its work can't be done in the browser. You don't annotate which is which; the classification falls out of the definition.

## The enforcing build errors

Three things are refused, each with a message that says what to change:

- **A server-pinned machine passed to `use()`.** The error **names the offending capability** — e.g. "reads machine `ProductsMachine` (cross-machine reads resolve server-side only)."
- **Server code reached from an island.** A module in an island's bundle that imports `@statorjs/stator/server` is named, along with what it imported.
- **A machine import the build can't place**, per the table above, located at its line in the `.stator` file.

You see them in three places. `stator dev` shows the error in the browser overlay when you save, and keeps serving the last good build. `stator check` reports all of them without bundling, so CI catches them. `stator build` runs the check first and applies the same analysis again when it bundles.

There's a runtime backstop too: a machine running client-side that somehow dereferences a `reads` helper hits throwing helpers rather than silently returning wrong data. The compile error is the front line; the runtime guard is the seatbelt.

## One reactivity model across the line

The boundary doesn't fork the programming model. `read(machine, selector)` is the same primitive on both sides — *declare on a node what state it shows*. The difference is only the transport: a server machine's binding updates by diff-and-patch; a client machine's by a local subscription writing the DOM. Learn it once, apply it on both sides. See [Reactivity and reads](/concepts/reactivity-and-reads/).

## No JSX on the client

The browser never re-runs your template. There is no client-side rendering engine and no client recompute loop. The server renders HTML; a client island mutates the already-rendered DOM through native APIs (and small binding helpers). DOM *creation* in the browser is allowed — via `<template>` cloning, `createElement`, custom elements — but never by re-executing the component's JSX. See [Rendering and patches](/concepts/rendering-and-patches/).
