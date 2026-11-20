---
title: 'Client-to-app dispatch: gateway machines now, route-gated dispatch later'
status: shipped
created: 2026-07-04
updated: 2026-11-20
area: runtime
---

## What and Why

Browsers cannot dispatch events to app-lifecycle machines. `/__events` and API-route `dispatch` both go through the session runtime, whose `loadGraph` skips non-session defs — an app-machine send throws "not loaded into this runtime". App machines accept input only via session→app subscription emits and server-side `dispatchToApp` (webhooks/cron/effect completions).

This is a **design stance, not missing plumbing**: `/__events` takes the machine name from the client's JSON body. Session machines are safe to dispatch by name (you can only mutate your own state); app machines are everyone's shared state, so a naive pass-through would let any visitor with devtools drive any app machine. Direct client→app dispatch is an authorization problem, and Stator has no auth primitives yet.

Decided 2026-07-04 (conversation, option-4 follow-up): **keep emit-only through 1.0** and document the gateway pattern as the supported path; revisit convenience in 1.x once an auth story exists.

## The supported 1.0 pattern: gateway session machines

A session machine is the command gateway and the authorization boundary — its guards run against the session's own context:

```ts
// AdminMachine (session): the gate
REQUEST_RESTOCK: {
  when: (ctx) => ctx.isAdmin,
  emit: 'restockRequested',
},

// InventoryMachine (app): inputs are an explicit, reviewable list
subscribes: [{ from: Admin, event: 'restockRequested', dispatch: 'REQUEST_RESTOCK' }],
```

Philosophically consistent with the rest of the framework: shared-state changes flow through declared seams, and the machine def is the audit trail. Cost: one relay event + emit + subscription triple per command. Documented in the app-machines guide.

## Decision (2026-11-20): the gateway is the rule

Decided with Tony: client events always go to session machines, and a session machine that needs shared state to change emits to an app machine that subscribes. The 1.0 stance stands as the design, not as a limitation awaiting a convenience.

Why the 2026-07 sketch (a route-level `appDispatch: [Inventory]` gated by route admission) was dropped: an app machine's guards see only the shared context and the event, never the sender. Route admission decides who reaches a page, but nothing inside the app machine can tell one admitted visitor from another, and event fields come from the browser.

Considered and set aside: **sessions on app transitions**, where an app machine's guards and handlers see the sending session (`{ id, claims }`) and direct sends become legal. It puts a session-shaped parameter on every app transition that is empty for `dispatchToApp`, cron and effect completions, and adds a second way into shared state beside `subscribes`. It is more rope than the audience needs: forgetting a relay leaves a button that does nothing, while forgetting a guard on a shared handler is a hole.

If the relay triple (event, emit, subscription) proves heavy for public commands, the answer is a shorthand for declaring a relay, not opening the wire.

## What shipped

- `/__events` refuses an app-machine send with a 403 that names the gateway (it was a 500 from "not loaded into this runtime").
- A def carries its lifecycle as a literal type, and `BrowserEventOf` makes a template `machine.send(…)` or an island `dispatch(Machine, …)` to an app machine a type error at the call, so `stator check` and the editor report it.
- The app-machines guide states the rule and its reasons.

## Success Criteria

- A browser send to an app machine is a 403 naming the gateway pattern, never a 500.
- `stator check` fails a template send or island dispatch to an app machine, located.
- The gateway pattern keeps working unchanged.

## Open Questions

- A relay shorthand, if real apps show the ceremony hurting.
- API-route `dispatch(Machine, event)` still refuses an app machine only at request time; it could take the same type treatment with its own message (`dispatchToApp`).
