---
"@statorjs/stator": minor
---

Image encoding stays inside its host's means. `images.threads` caps the libvips worker pool — sharp's default is the *reported* core count, which on shared-cpu hosts is the physical machine's, so a single AVIF encode could fan out 8+ threads of encoder demand on a fractional vCPU (found as a swap-thrash lockup on a 512MB host; set `1` on small machines). `images.encodeTimeoutMs` (default 15s, `0` disables) enforces the on-demand contract: past the deadline the request degrades to a `302` at the stored original — real pixels now, `no-store` so nothing caches the fallback — while the encode keeps running to fill the variant cache for the next visitor.
