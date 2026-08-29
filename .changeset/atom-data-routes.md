---
"@statorjs/stator": patch
---

Data routes recognize the `.atom` extension (`feed.atom.ts` → `/feed.atom`, served as `application/atom+xml`) — Atom feeds no longer need a raw `Response` that gives up the free ETag/304.
