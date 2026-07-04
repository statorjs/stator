---
title: Rendering and patches
description: "The render pass, binding registration, and the target/op patch model."
sidebar:
  order: 5
---

This page traces what happens between "a machine changed" and "the DOM updated" — the render pass that registers bindings and the wire format that carries the changes.

## The single render pass

Rendering a route runs once, synchronously, against an active render state. As the template executes, each `read()`, `each`, `when`, and reactive directive **registers a binding** on that render state and produces HTML. By the time the pass finishes, the server holds two things: the HTML to send, and a map of every binding on the page keyed by slot id and indexed by source machine.

This pass is the only time the template runs. After it, the page is just registered bindings — there's no template re-execution to update the DOM, only [recompute](/concepts/reactivity-and-reads/#recompute-and-diff) and patching.

## Slot and element id allocation

Bindings address the DOM two ways:

- **Slot ids** mark a position in content (the text a `read()` controls). List and branch bodies push a **scope prefix**, so a slot inside the third cart line has an id scoped to that line — ids stay stable and unambiguous as lists grow.
- **Element ids** mark a specific element (the target of an attribute patch).

The allocation is deterministic within a render so the same binding gets the same address on every pass.

## The target/op wire format

A patch is two orthogonal parts: a **target** (where) and an **op** (what to do there).

```ts
type Patch =
  | { target: { kind: 'slot';    id: string }; op: 'text'; value: string }
  | { target: { kind: 'slot';    id: string }; op: 'html'; value: string }
  | { target: { kind: 'element'; id: string }; op: 'attr'; name: string; value: string }
```

Targets and ops are independent dimensions, which is what keeps the format small and extensible: new capabilities are new ops or new targets, not a new message type.

`insert` / `remove` / `move` on slot targets are the [keyed-list](/guides/keyed-lists/) ops: emitted from a server-side diff, applied sequentially against the list's element children by index. An unkeyed list still re-renders its body via one `html` patch.

:::note[1.x]
`attr-add` / `attr-remove` and `prop` on element targets are reserved in the format but not yet emitted.
:::

## Scope subsumption

When a list or branch body is replaced wholesale with an `html` patch, that new HTML already contains the fresh values of every binding inside it. Any finer-grained `text`/`attr` patches whose slots live inside that scope are therefore redundant — and applying them afterward would either no-op or hit the wrong element. The recompute pass detects this and **drops the subsumed descendant patches**, sending only the one `html` patch. It's the difference between a correct update and a flicker of stale-then-fresh.

## Native DOM apply

On the client, a tiny applier dispatches each patch on `target.kind` then `op` and performs the corresponding native DOM operation — set text, swap inner HTML, set or remove an attribute. There's no framework runtime reconciling a tree; it's direct DOM mutation. An unknown op is logged and skipped rather than throwing, so a newer server speaking a not-yet-supported op degrades gracefully.

## Transport-agnostic

The same patch shape travels over both transports. A POST event response and an [SSE](/guides/realtime-sse/) push carry identical patch lists — the recompute pass doesn't know or care which one is delivering its output. That's why making a route live changes nothing about how it renders: only the channel differs.
