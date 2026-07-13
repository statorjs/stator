---
"@statorjs/stator": patch
---

API-route `dispatch()` now returns `{ committed: boolean }`, matching the
client dispatch contract — login-style handlers can distinguish a
guard-dropped event (wrong credentials) from a committed one without
guessing.
