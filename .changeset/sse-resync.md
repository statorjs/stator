---
"@statorjs/stator": patch
---

Live pages resync instead of reloading after a dropped or stale SSE connection. The server already pushes a full initial sync on every fresh connection, so the client now just reopens the channel and lets that sync converge the page in place — scroll, focus, and island state survive where a reconnect previously forced a full page reload. The half-open-channel watchdog rebuilds the connection the same way.
