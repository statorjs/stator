# @statorjs/stator

## 1.2.0

### Minor Changes

- 1b8eb1f: `rotateSession()` in API route helpers — the session-fixation defense for
  privilege changes. Call it on login and the whole session (every persisted
  machine) moves to a freshly minted id, with the response carrying the new
  cookie; call `rotateSession({ clear: true })` on logout and the old
  session's state is deleted outright. Backed by a new optional
  `renameSession` on the `Store` interface, implemented by all built-in
  stores (in-memory, Redis via atomic `RENAME`, cached write-through).

### Patch Changes

- 8739e88: Every server dispatch surface now reports whether the event actually
  committed, matching the client dispatch contract: API-route `dispatch()`
  and `dispatchToApp()` both return `{ committed: boolean }`. Login-style
  handlers can distinguish a guard-dropped event (wrong credentials) from a
  committed one, and webhook receivers can tell a processed event from a
  guard-dropped duplicate.

## 1.1.1

### Patch Changes

- e8871d3: Port collisions stopped being stack traces. The dev server now shifts to the
  next free port when the requested one is busy (noted in the banner) and
  probes a free HMR websocket port, so two Stator apps run side by side
  without fighting over 24678. Production stays strict about its port but
  fails with a one-line message instead of an unhandled `EADDRINUSE`.
