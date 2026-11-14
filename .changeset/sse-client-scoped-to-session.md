---
"@statorjs/stator": patch
---

A live connection's page-load id counts only within its own session. A request from another session naming the same id could evict that page's connection, or make it skip a diff so the update never arrived.
