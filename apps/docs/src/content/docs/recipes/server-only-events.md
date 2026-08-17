---
title: Server-only events
description: "An effect completion like CHARGE_APPROVED is server truth, not a client intent. Declare it serverOnly and a forged POST that fakes settlement is rejected at the wire boundary."
sidebar:
  order: 8
---

Every event a client sends arrives at the same place — a `POST /__events` with a machine name and an event `type`. That is exactly what a `<button on:click={() => cart.send({ type: 'BEGIN_CHECKOUT' })}>` produces, and it is also exactly what anyone can type into a devtools console against your running app. The wire does not know which events your UI *meant* to expose.

Most events are fine to expose — a guard-dropped `ADD` or a role-checked `MODERATE` fails harmlessly. The dangerous ones are the events your machine *handles* but no client should ever *send*: effect completions (`CHARGE_APPROVED`, `SAVE_OK`), `after:` timer events, and cross-machine internals. These are server truth. A machine handles `CHARGE_APPROVED` because its own charge effect returns it — so a client that POSTs `CHARGE_APPROVED` directly is claiming a settlement that never happened.

## Declare them `serverOnly`

List the event types no client may send. The declaration is typechecked against the machine's event union, so a name that isn't a real event is a compile error.

```ts
// machines/cart.ts
export default defineMachine({
  name: 'CartMachine',
  events: {} as Events,
  // The settlement events come only from the charge effect — the amount is
  // computed from context, never supplied by the client. A forged POST of one
  // is a paid order without a charge.
  serverOnly: ['CHARGE_APPROVED', 'CHARGE_DECLINED'],
  // ...
})
```

Now a client POST of `CHARGE_APPROVED` to `/__events` is rejected with **403** at the wire boundary, before any dispatch. Your UI is unaffected — it drives checkout with `BEGIN_CHECKOUT`, `SET_CONTACT`, `SET_SHIPPING`, `SUBMIT`, none of which are server-only. Only the sealed completions are unreachable from the wire.

The completion still reaches the machine the way it always did. When the charge effect returns `{ type: 'CHARGE_APPROVED', ... }`, that event re-enters through the **internal** dispatch path, which never touches `/__events`. The gate blocks the forgeable wire path and leaves the legitimate server path open.

## It's a coarse gate, not authorization

`serverOnly` answers one question: *could a client ever legitimately send this event?* For a completion, the answer is no, for everyone, always — so it's a flat list, not a per-user rule.

Whether *this* user may commit an event they *are* allowed to send is still the machine **guard's** job. A `DELETE_ALL` button on an admin page makes `DELETE_ALL` client-sendable for every session that renders it — the guard (`when: (ctx) => ctx.role === 'admin'`) is what decides if it commits. Coarse gate plus fine guard, the same layering as [middleware admission plus in-route guards](/guides/middleware/).

## Enforced in dev and prod

The gate runs everywhere. Because the declaration is explicit — you asserted these events are server-generated — there is no false-positive risk and no dev/prod divergence: a UI that accidentally dispatches a server-only event fails the same 403 locally that it would in production, so you catch it while building.

## When a completion needs to carry proof

`serverOnly` closes the wire path. If you also want a completion to be unforgeable on the *internal* path — say an effect in one machine dispatches into another, and you want to prove it was your effect that did it — fall back to the pattern the whole engine is built on: make the event **carry its own proof**. The effect stashes a server-set nonce in context and the completion's guard requires it.

```ts
// the effect mints a nonce the completion must present
effect: async (ctx) => {
  ctx.pending = crypto.randomUUID()        // server-set, never sent to the client
  const receipt = await chargeCard(ctx.totalCents)
  return { type: 'CHARGE_APPROVED', receiptId: receipt.id, nonce: ctx.pending }
},
// ...
CHARGE_APPROVED: {
  when: (ctx, ev) => ev.nonce === ctx.pending,   // a forged completion has no nonce
  to: 'confirmed',
  do: (ctx) => { ctx.pending = '' },
},
```

For the common case — a completion no client should ever send — `serverOnly` is the whole answer. Reach for the nonce guard when a completion crosses a trust boundary *inside* the server and you want the guard, not just the wire, to enforce it.

The [reference storefront](https://github.com/statorjs/stator/tree/main/apps/store) uses `serverOnly` on its cart's charge completions — the running example behind this recipe.
