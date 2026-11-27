---
'@statorjs/stator': minor
---

A guard can say why it refuses. `helpers.refuse(code, { message?, issues? })` in a guard records a reason and returns `false`, so `return refuse('duplicate', { issues: [{ path: ['email'], message: 'That email is already on the roster.' }] })` and `(a || refuse('a')) && (b || refuse('b'))` work the way boolean guards always have. `actor.send()` now returns `{ committed, refusal? }` instead of `void`. The first reason recorded during one `send` is the one reported; with several candidates it is reported only when every candidate refused, and a candidate that passes drops it. An event the current state does not handle, or a guard that returns `false` without calling `refuse`, gives `{ committed: false }` with no reason. The reason is never stored: it is not in the snapshot and nothing persists it. `refuse` exists only on guard helpers (`GuardHelpers`); actions keep `ActionHelpers`, and a guard typed against `ActionHelpers` still assigns. `Refusal`, `RefusalIssue`, `GuardHelpers` and `SendResult` are exported from `@statorjs/stator/machine`.

Upgrading resets persisted sessions once. The engine hash is an input to every machine's hash, and this change edits the engine, so every session machine and every `persist: true` app machine starts fresh on the first deploy of this release. Machines that never call `refuse` behave as before.
