---
"@statorjs/stator": minor
---

`meta.session` on effects. For session machines, every effect — entry and transition — now receives the session it runs for: `meta.session.id` and `meta.session.claims<T>()`, the same app-defined claims middleware reads with `stator(c).claims()`. It is what lets an entry effect reload a durable fact by identity on a fresh start, after TTL expiry, or after a snapshot reset — `loadCart(meta.session.claims<Me>().userId)` — with no client round trip. App machines have no session and client islands run no host, so `meta.session` is `undefined` there. The engine stays session-unaware: `EffectInvocation.run(signal, session?)` merges whatever the host passes.
