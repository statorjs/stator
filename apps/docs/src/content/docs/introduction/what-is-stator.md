---
title: What is Stator?
description: "Stator in one paragraph: a server-canonical framework built around isomorphic state machines."
sidebar:
  order: 1
---

Stator is a **server-canonical** web framework. Your application's state lives in **state machines** on the server; your templates **read** from those machines; and **events** are the only thing that changes state. When state changes, the server computes the minimal set of DOM updates and sends them back as small patches — so the page changes exactly where its underlying state changed, and nowhere else.

## Stator in one paragraph

Most frameworks put state inside the component tree and reconcile a virtual DOM to keep the screen in sync. Stator inverts that. A machine is the single source of truth for a slice of state; a template declares, on each node, which piece of machine state that node displays; and an event handler sends a typed event to a machine. There is no client-side re-render loop to reason about — the server already knows which reads depend on which machine, so it patches only the affected nodes.

## "DOM renders where its state lives"

This is the one axiom everything else follows from. A node that shows `read(cart, c => c.total)` is bound to the cart's total; when the cart changes, that node — and only that node — updates. "Server-canonical" isn't a separate design choice you opt into, it's the consequence: if state is canonical in a machine and the DOM renders where that state lives, then the machine, and therefore the rendering authority, lives on the server.

Interactivity that genuinely belongs in the browser (a theme toggle, an open/closed menu) opts *out* into a [client island](#opt-in-client-islands) — a small custom element whose machine runs in the browser. The boundary between the two is decided by one thing: where you import the machine.

## What you get

- **`.stator` single-file components** — frontmatter for imports and props, a JSX-flavored body, scoped `<style>`, and an optional client `<script>`.
- **Typed state machines** — `defineMachine` with a typed event union, transitions, guards, selectors, and cross-machine composition.
- **Machine-mediated dispatch** — you address a machine by its imported definition and send a typed event; no magic strings.
- **Slot-level server rendering** — `read(machine, selector)` registers a binding; changes come back as targeted DOM patches over a small wire format, never a full re-render.

### Opt-in client islands

When a piece of state should never touch the server, a `.stator` file can *be* a custom element: its `<script>` exports a `StatorElement` subclass and its machine runs in the browser. You reach for an island deliberately, not by default. See [Client components](/guides/client-components/).

## How it differs

- **vs. React / RSC** — no file coloring. A machine is neither "server" nor "client" by declaration; where it runs is decided per use site by import location, and the compiler checks portability.
- **vs. Astro** — Astro ships islands of components; Stator's unit is the machine, and the server stays authoritative for state, not just the initial HTML.
- **vs. Svelte / Solid** — the same goal of fine-grained updates, but reactivity is a machine read you *declare on a node*, computed server-side, not a compiler-tracked signal in the browser.
- **vs. HTMX** — the same "HTML over the wire" instinct, but you send typed events to typed machines and get back structured patches, not opaque fragments.

## What Stator is not (today)

:::caution[1.0 scope]
Stator 1.0 targets a **single-replica** deployment. Durable app→session delivery (the inbox), horizontal scaling across replicas, and nested/parallel statecharts are explicitly deferred to 1.x. See [Why Stator](/introduction/why-stator/#the-10--1x-boundary) for the full boundary.
:::

## Where to go next

- [Why Stator](/introduction/why-stator/) — the problems it solves and the tradeoffs you accept.
- [The mental model](/introduction/mental-model/) — the whole model in one read.
- [Quick start](/introduction/quick-start/) — a running app in a few minutes.
