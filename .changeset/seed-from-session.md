---
'@statorjs/stator': minor
---

`seed` on a session machine: where a fresh start begins, given the session's claims. A session's claims survive a snapshot reset (a deploy that changed the machine, TTL expiry, a flushed store), but a machine that keeps "signed in" as state came back at `initial` and rendered the sign-in form to a session that had already passed it. `seed: (session) => ({ state, context })` runs synchronously before the first render on every fresh start — a new session or a reset — and is never consulted when a snapshot hydrates. A seeded state is entered for real: its entry effect fires and its `after` timers arm. Declaring it on an app machine is an error. The engine's `actor.seed(partial, state?)` gains the optional state. The `with-auth` starter's AuthMachine seeds from its claims, re-reading the user row so nothing is trusted from a cookie.
