---
"@statorjs/stator": minor
---

`rotateSession()` in API route helpers — the session-fixation defense for
privilege changes. Call it on login and the whole session (every persisted
machine) moves to a freshly minted id, with the response carrying the new
cookie; call `rotateSession({ clear: true })` on logout and the old
session's state is deleted outright. Backed by a new optional
`renameSession` on the `Store` interface, implemented by all built-in
stores (in-memory, Redis via atomic `RENAME`, cached write-through).
