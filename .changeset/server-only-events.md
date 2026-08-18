---
"@statorjs/stator": minor
---

`serverOnly` event declaration — seal the events no client should ever send. A machine can now list event types that are server-generated only (effect completions like `CHARGE_APPROVED`, `after:` timers, cross-machine internals):

```ts
defineMachine({
  name: 'CartMachine',
  events: {} as Events,
  serverOnly: ['CHARGE_APPROVED', 'CHARGE_DECLINED'],
  // ...
})
```

A client `POST /__events` of a server-only event is rejected with **403** at the wire boundary, before dispatch — closing the forged-completion hazard (a `CHARGE_APPROVED` that fakes a settled charge). The list is typechecked against the machine's event union, so a name that isn't a real event is a compile error.

The completion still reaches the machine normally: an effect returning `{ type: 'CHARGE_APPROVED' }` re-enters through the internal dispatch path, which never touches `/__events`. The gate blocks only the forgeable client wire path.

Enforced in **dev and prod alike** — the declaration is explicit, so there's no false-positive risk and no dev/prod divergence (a UI that accidentally dispatches a server-only event fails the same 403 locally). This is a coarse origin gate ("could a client ever send this"), not per-user authorization — machine guards still own that.

The reference storefront's cart uses it on its charge completions; the new [Server-only events](https://stator.dev/recipes/server-only-events/) recipe walks the pattern (including the nonce-guard for completions that cross a trust boundary inside the server).
