---
"@statorjs/stator": patch
---

The image endpoint gains a global encode semaphore (`images.concurrency`, default 2): different cold-cache variants queue behind a small number of concurrent transforms instead of fanning out unbounded. Found in production the first hour a gallery page ran on a 512MB host — a dozen simultaneous AVIF encodes OOM-killed the machine. The per-path stampede dedup already prevented duplicate encodes; this bounds the aggregate.
