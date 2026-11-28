---
'@statorjs/stator': patch
---

An event whose type names an `Object.prototype` member (`constructor`, `toString`, `hasOwnProperty`, `__proto__`, `valueOf`) is no longer treated as handled. The actor looked handlers up with plain indexing, so it found the prototype's member and committed the event, bumping the commit count and persisting, even though the machine declared no such handler. Handler and state lookups now read own properties only: such an event gives `{ committed: false }` with no reason, like any event the current state does not handle, and a machine that does declare a handler named `toString` still handles it. `seed()` into a state named `constructor` now throws, as for any state the machine does not have. `/__events` already rejected these types; the paths this fixes are subscription `dispatch`, `dispatchToApp` and an island's `send`.

Upgrading resets persisted sessions once. The engine hash is an input to every machine's hash, and this change edits the engine, so every session machine and every `persist: true` app machine starts fresh on the first deploy of this release. It lands in the same release as the other engine changes, so that is still one reset.
