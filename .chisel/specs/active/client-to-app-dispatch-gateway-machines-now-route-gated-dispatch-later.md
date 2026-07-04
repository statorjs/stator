---
title: 'Client-to-app dispatch: gateway machines now, route-gated dispatch later'
status: draft
created: 2026-07-04
updated: 2026-07-04
area: runtime
---

## What and Why

Browsers cannot dispatch events to app-lifecycle machines. `/__events` and
API-route `dispatch` both go through the session runtime, whose `loadGraph`
skips non-session defs — an app-machine send throws "not loaded into this
runtime". App machines accept input only via session→app subscription emits
and server-side `dispatchToApp` (webhooks/cron/effect completions).

This is a **design stance, not missing plumbing**: `/__events` takes the
machine name from the client's JSON body. Session machines are safe to
dispatch by name (you can only mutate your own state); app machines are
everyone's shared state, so a naive pass-through would let any visitor with
devtools drive any app machine. Direct client→app dispatch is an
authorization problem, and Stator has no auth primitives yet.

Decided 2026-07-04 (conversation, option-4 follow-up): **keep emit-only
through 1.0** and document the gateway pattern as the supported path;
revisit convenience in 1.x once an auth story exists.

## The supported 1.0 pattern: gateway session machines

A session machine is the command gateway and the authorization boundary —
its guards run against the session's own context:

```ts
// AdminMachine (session): the gate
REQUEST_RESTOCK: {
  when: (ctx) => ctx.isAdmin,
  emit: 'restockRequested',
},

// InventoryMachine (app): inputs are an explicit, reviewable list
subscribes: [{ from: Admin, event: 'restockRequested', dispatch: 'REQUEST_RESTOCK' }],
```

Philosophically consistent with the rest of the framework: shared-state
changes flow through declared seams, and the machine def is the audit trail.
Cost: one relay event + emit + subscription triple per command. Documented in
the app-machines guide.

## 1.x direction (sketch, not committed)

Route-gated capability, not a machine-level flag (a `clientDispatch: true`
flag would still let *any* session send):

```ts
export const GET = defineRoute({
  reads: [Inventory],
  appDispatch: [Inventory], // /__events accepts app sends only from pages declaring it
  render: /* … */,
})
```

Pairs with whatever auth guards the page itself — which presupposes a route
auth story that is itself unspecced. Sequence: route auth primitive first,
then this.

## Success Criteria

(For the 1.x work, when picked up.)

- An admin page can drive an app machine without a relay machine, gated by a
  route-level declaration + the route's auth.
- A page without the declaration gets a 4xx for app-machine sends — never a
  silent pass-through.
- The gateway pattern keeps working unchanged.

## Open Questions

- The route auth primitive this depends on (middleware? a `guard` on
  defineRoute? session-context conventions?).
- Whether the Allbirds demo's admin surface makes the relay ceremony painful
  enough to justify pulling this forward.
