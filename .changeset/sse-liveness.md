---
"@statorjs/stator": patch
---

Live pages recover from zombie SSE connections. The server heartbeat is now an observable data frame (`{"ping":true}`) instead of a comment, and the client runtime watches for it — two missed pings on a visible page closes the dead channel and reloads to re-sync. Fixes live updates silently stopping after device sleep or a silent network drop, which previously left pages looking connected while receiving nothing (surfaced as a refresh spinner that never stopped).
