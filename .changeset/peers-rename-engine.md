---
'@statorjs/stator': minor
---

`peers` is the new name for a machine's `reads`. `defineMachine({ peers: [Inventory] })` declares the machines this one consults, and `helpers.peers` is the typed map of them in actions, guards and selectors. `reads:` and `helpers.reads` keep working through 3.x as deprecated aliases (struck through in the editor) and are removed in 4.0. Every helpers object carries the same map under both keys, so a machine can move one use at a time. Declaring both `peers` and `reads` on one machine throws at definition: `got both peers and reads — keep peers`. `createActor`'s `resolveHelpers` may return the map under either key. `MachineDef` and `describeMachine()` gain `peers` beside `reads`, and `PeersMap` is exported, with `ReadsMap` as its deprecated old name. Error messages about a missing or misused peer now say `peers`.

One type-level break: a helpers object built by hand and typed as `ActionHelpers` (a test calling a selector or guard directly with `{ reads: stub }`) no longer typechecks, because `ActionHelpers` now has `peers` as well as `reads`. Pass both keys, `{ peers: stub, reads: stub }`, or cast the stub. Nothing changes at runtime.

Upgrading resets persisted sessions once. The engine hash is an input to every machine's hash, and this change edits the engine and the actor host, so every session machine and every `persist: true` app machine starts fresh on the first deploy of this release. Renaming `reads:` to `peers:` (or `{ reads }` to `{ peers }`) in a machine's source changes that machine's code, so it resets that machine, and any machine that imports it, once more on the deploy that carries the rename; doing the rename in the same deploy as the upgrade costs one reset.
