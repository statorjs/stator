---
title: "client"
description: "Island authoring: StatorElement, use, the terse machine sugar, bind, and typed dispatch."
sidebar:
  order: 5
---

`@statorjs/stator/client` is the browser-safe surface a `.stator` `<script>` island compiles against — and the symbols you reference directly inside one.

## StatorElement

```ts
class StatorElement extends HTMLElement {
  static attrs?: Record<string, (raw: string) => unknown>  // declared attribute surface
  get attrs(): Record<string, unknown>   // typed, coerced attribute reads
  attr<T>(name: string, coerce?: (raw: string) => T): T | undefined
  get refs(): Record<string, HTMLElement> // ref:-marked elements, by data-ref
  protected setup(): void                 // compiler-generated wiring runs here
  protected track(dispose: () => void): void
}
```

The base class for a client island. Declare attributes with `static attrs = { unitPrice: Number, selected: Boolean }`; `this.attrs.unitPrice` then reads the kebab-case DOM attribute (`unit-price`) and coerces it — `Boolean` is a presence flag. `attr()` is the raw escape hatch for dynamic or undeclared attributes; `refs` resolves `ref:`-marked elements lazily.

Element lifetime owns actor lifetime: on connect, actors created via `use()` are seeded and started and `setup()` runs; on disconnect, tracked disposers run and actors stop. Full-page navigation therefore resets client state — the intended default for ephemeral UI.

## use

```ts
function use(
  def: MachineDef,
  seed?: Record<string, unknown> | (() => Record<string, unknown>),
): ClientInstance
```

Instantiates a client machine as a class field (`qty = use(Qty)`), owned by the element's lifecycle. The returned `ClientInstance<D>` exposes every selector and context key as a live **typed** property (read through the actor's current snapshot on each access) plus `send(event)` — `qty.count` is a `number`, and a typo'd property is a compile error.

The optional seed sets initial context. A plain object applies eagerly; pass a **thunk** — `use(Qty, () => ({ max: this.attrs.max }))` — when the seed reads `this.attrs`, because attributes aren't available during construction (the custom-element upgrade-timing rule). The thunk is deferred to connect.

## machine

```ts
function machine<C, S>(context: C, behavior?: ClientBehavior<C> & { select?: S }): MachineDef<C, ClientEvent, 'active', S>

// context: plain data (typed; handlers and selectors see it)
// behavior:
{
  name?: string                          // label only; defaults to "ClientMachine"
  on?: Record<string, Transition>        // bare fn = action; object = { when?, do?, emit? }
  select?: Record<string, (ctx: C) => unknown>  // exposed as typed instance properties
}
```

Terse sugar for component-local state — desugars to a single-state `defineMachine`:

```ts
const Counter = machine(
  { count: 1 },
  {
    on: { INC: (s) => s.count++ },       // s.count: number
    select: { atMax: (s) => s.count >= 99 },
  },
)
```

Reach for it when a full state chart is ceremony; graduate to `defineMachine` when you need real states.

## bind

```ts
function bind(deps: ClientInstanceBase[], compute: () => unknown, apply: (value) => void): () => void
function effect(deps: ClientInstanceBase[], fn: () => void): () => void
```

The one client binding mechanism — the client mirror of the server's recompute loop. `bind` subscribes to the dep actors and, on any change, re-evaluates `compute`, diffs against the last value with `Object.is`, and calls `apply` only when it changed. The compiler emits one `bind()` per client-machine `read()`; you rarely write it by hand. `effect` is the imperative escape hatch: run `fn` now and on every dep change, no diffing — `fn` owns its own DOM writes. Both return a disposer.

## dispatch

```ts
function dispatch<D extends MachineDef>(machine: D, event: EventOf<D>): Promise<DispatchResult>
// DispatchResult: {
//   ok: boolean; committed: boolean; patchCount: number
//   error?: { phase: 'network' | 'timeout' | 'http'; status?: number }
// }
```

The one visible boundary crossing from an island: commits an event to a **server** machine by POSTing `{ machine: machine.name, event }` to `/__events`, then applies the returned patches and directives to the DOM. Addressed by the imported machine def, not a magic string — the compiler turns a server-machine import into a `{ name }` stub, and the event type-checks against that machine's event union. The result separates three facts: `ok` (the POST reached the server), `committed` (the event actually transitioned a machine — a guard-dropped event is `ok && !committed`), and `patchCount` (patches applied to *this* page; a committed event may patch zero slots here if the touched machines aren't bound on the current route). Buttons that announce success should look at `committed`. Failures resolve rather than throw: `ok` is false and `error.phase` says what happened — `network` (the request never completed), `timeout` (it exceeded the 10-second deadline), or `http` (the server answered non-2xx, with `status`). Every failure also fires the `stator:dispatch-error` window event described below.

## Runtime signals

The page runtime marks in-flight and connection state on the DOM so plain CSS can react, and mirrors both as `stator:*` window events for code.

**`data-stator-pending`** — set on the element whose event POST is in flight (the `data-event-*` element, or the form for `data-event-submit` and enhanced submits), removed when the response is applied or the request fails. Rapid repeat dispatches keep it until the last one settles.

```css
button[data-stator-pending] { opacity: 0.6; pointer-events: none; }
```

**`data-stator-connection`** — set on `<html>` for routes with `live: true`, one of `connected`, `disconnected`, or `stale` (the half-open-channel watchdog fired). Absent on non-live routes.

```css
html[data-stator-connection="disconnected"] .offline-banner { display: block; }
```

**Window events** — `stator:dispatch-error` fires once per failed dispatch with `{ machine?, event?, phase, status?, timestamp }` (`machine` is absent for enhanced form submits), and `stator:connection-state` fires on every connection transition with `{ state, timestamp }`. Event POSTs are aborted after a 10-second deadline, so a dead-slow connection surfaces as `timeout` instead of hanging on the browser's own limits.

**Retries** — machine-event POSTs carry a per-dispatch idempotency key and retry network and timeout failures twice (300ms then 1s backoff) before giving up. The server replays a duplicate's original response instead of re-applying it, so a retry after a lost response can't double-commit. Non-2xx responses never retry — the server answered. Enhanced form submits go to arbitrary handlers, so they get the timeout but no automatic retry.

## Lower-level exports

- `defineElement(UserClass, tag)` — registers an island class against its custom-element tag; the compiler emits this call.
- `ClientInstance` — the reactive handle `use()` returns; `ClientInstanceBase` — the untyped base `bind`/`effect` accept as deps.
- `ClientBehavior<C>` — the `machine()` behavior shape (`name` / `on` / `select`); `LegacyMachineConfig` — the deprecated one-bag form.
- `DispatchResult` / `DispatchError` — the result and error shapes `dispatch` resolves with.
