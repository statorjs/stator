---
"@statorjs/stator": minor
---

Deploy-aware reload — a live page from a stale build reloads itself. The server now stamps a build identifier into every live page (`<meta name="stator-build">`) — per-boot in dev, per-build in production (written to the build manifest). The client echoes it on the `/__sse` connection, and if the server is now serving a different build, it tells the page to hard-reload instead of resyncing onto a slot map that may no longer match.

This closes two gaps:

- **Dev:** a `tsx`-side server restart previously fired no browser reload, so a changed DOM↔slot-ID contract could silently break patches. Now the restart is a new build-id → the client reloads on reconnect.
- **Prod:** after a deploy, still-open pages reconnect to the new build and reload, rather than applying patches against the old layout.

Per-build (not per-boot) in production, so a crash-restart of the *same* build doesn't reload everyone — only an actual deploy does. Fully graceful: an app with no build-id (a build predating this, or a hand-written server that doesn't set one) simply keeps today's resync-never-reload behavior.
