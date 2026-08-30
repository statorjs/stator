---
"@statorjs/stator": patch
---

Data GET routes accept `revision: () => string | number` — a cheap fingerprint of everything the body depends on (one indexed `max(updated_at)` SELECT, typically). The ETag derives from it, and a matching `If-None-Match` answers a bodyless 304 **without invoking the handler**: a polling feed reader or sitemap crawler costs the fingerprint, not the render. Full responses carry the same revision ETag, and derived Cache-Control applies to the 304 path too. The revision must change whenever the body could — soft-deletes and edits that stamp `updated_at` satisfy this for free.
