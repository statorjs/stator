---
title: Reactivity and reads
description: "read() registers a binding; recompute diffs it; the wire carries minimal patches."
sidebar:
  order: 3
---

Stator's reactivity has no magic in it — no proxies tracking field access, no signal graph, no dependency inference. You declare, on each node, exactly which state it shows. This page explains how that declaration becomes a minimal DOM update.

## Explicit reads, no auto-tracking

A node that shows reactive state says so with `read(machine, selector)`:

```astro
<p>Total: {read(cart, c => c.total)}</p>
```

Nothing else is reactive. A bare `{cart.total}` would render once and never update. This is a deliberate trade: you type a little more, and in exchange the set of things that can update — and the reason each one does — is legible directly from the template. There is no "why did this re-render?" because the dependency is the selector you wrote, nothing more, nothing less.

## read() registers a binding

`read()` does two things during the render pass: it runs the selector to get the current value for the initial HTML, and it **registers a binding** against the surrounding node — capturing the machine, the selector, the value, and an allocated slot id. The machine instance is a proxy that reads through the live snapshot, so re-running the selector later always sees fresh state.

Bindings come in a few **kinds** depending on position: `text` (a slot in text content), `attr` (a whole attribute value), and the list/branch bindings produced by `each`/`when`/`match`. Each kind knows how to diff and how to patch itself.

## Slots and bindings

Every binding is filed two ways:

- By its **slot id** — the address of the spot in the DOM it controls.
- By its **source machine** — an index (`byMachine`) from a machine name to the set of slots that read it.

That second index is the efficiency win. When an event touches `CartMachine`, the server doesn't re-check every binding on the page — it looks up exactly the bindings that read the cart and recomputes only those.

## Recompute and diff

After a transition, the recompute pass walks the bindings for each touched machine, re-evaluates each selector, and compares the result against the value stored at render time:

- If the value is unchanged, nothing is emitted.
- If it changed, a [patch](/concepts/rendering-and-patches/) is produced targeting that binding's slot, and the stored value is updated.

Equality is pragmatic: `Object.is` first, then a shallow type check, then a `JSON.stringify` comparison for objects and arrays. The point is to suppress patches for values that are structurally the same, so the wire only carries genuine changes.

A binding produced by `when`/`match` reduces to a **key**: the branch re-renders only when the chosen branch changes, not every time the underlying value is merely truthy in a different way.

## The bind: mirror on the client

Inside a [client island](/guides/client-components/), the same idea runs without a server. `bind:text={theme.label}` subscribes to a local actor and writes the DOM when the selector's value changes — a local subscribe-and-write with no recompute pass and no wire. `read()` and `bind:` are the two faces of one primitive: *declare on a node what state it shows.* The server diffs and patches; the client subscribes and writes. The mental model is identical on both sides of the [boundary](/concepts/server-client-boundary/).
