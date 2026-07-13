---
"@statorjs/stator": patch
---

Every server dispatch surface now reports whether the event actually
committed, matching the client dispatch contract: API-route `dispatch()`
and `dispatchToApp()` both return `{ committed: boolean }`. Login-style
handlers can distinguish a guard-dropped event (wrong credentials) from a
committed one, and webhook receivers can tell a processed event from a
guard-dropped duplicate.
