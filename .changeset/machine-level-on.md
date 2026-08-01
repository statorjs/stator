---
"@statorjs/stator": minor
---

Machines can declare a top-level `on:` — handlers that apply in any state, consulted only when the current state does not declare the event (a state-scoped handler always wins). This is the home for a completion event whose handling must not depend on an unrelated machine-wide state — e.g. a per-record save completing while the machine is busy reloading a collection. Without it, such a completion was silently dropped wherever the current state had no handler for it.
