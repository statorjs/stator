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

### The explicit anti-goal

Stator deliberately avoids the alternatives:

- No `"use client"` / `"use server"` directives.
- No file coloring (a file isn't "a client file" or "a server file").
- No viral transitivity, where one annotation forces annotations up the import graph.

These are the things that make the React Server Components boundary hard to hold in your head. Import location is local, visible, and non-viral — you can answer "where does this run?" by looking at one import, never the whole graph.

## The definition is location-agnostic

A machine definition has no inherent side. The same `defineMachine(...)` can run on the server in one place and in the browser in another; nothing about the definition changes. This is what makes a machine's selectors **isomorphic** — the `total` selector you `read()` on the server is the same function a client island would `bind:` against. You author the logic once and place it where each use needs it.

## Portable vs server-pinned at the use site

Placement is your decision; **legality** is the compiler's. A [portable](/concepts/state-machines/#capabilities) machine (no cross-machine reads, no server-only capability) can go in a `<script>`. A server-pinned one cannot — its work can't be done in the browser. You don't annotate which is which; the classification falls out of the definition.

## The enforcing compile errors

If you import a server-pinned machine into a client `<script>`, compilation fails with an error that **names the offending capability** — e.g. "reads machine `ProductsMachine` (cross-machine reads resolve server-side only)." You learn the *why*, not just the *what*, at build time.

There's a runtime backstop too: a client actor that somehow dereferences a `reads` helper hits throwing helpers rather than silently returning wrong data. The compile error is the front line; the runtime guard is the seatbelt.

## One reactivity model across the line

The boundary doesn't fork the programming model. Server `read(machine, selector)` and client `bind:` are two faces of the same primitive — *declare on a node what state it shows*. The difference is only the transport: the server diffs bindings and sends patches; the client subscribes locally and writes the DOM. Learn it once, apply it on both sides. See [Reactivity and reads](/concepts/reactivity-and-reads/).

## No JSX on the client

The browser never re-runs your template. There is no client-side rendering engine and no client recompute loop. The server renders HTML; a client island mutates the already-rendered DOM through native APIs (and small binding helpers). DOM *creation* in the browser is allowed — via `<template>` cloning, `createElement`, custom elements — but never by re-executing the component's JSX. See [Rendering and patches](/concepts/rendering-and-patches/).
