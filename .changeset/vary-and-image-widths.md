---
"@statorjs/stator": patch
---

`cors()` sends `Vary: Origin` on every response, not only when the origin matched, so a shared cache can't serve the answer it stored for one origin to another. The image endpoint accepts `w` and `h` only in their plain spelling (`400`), so `400.0`, `4e2` and `0x190` no longer each become a separate CDN cache entry for the same variant.
