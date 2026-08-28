---
"@statorjs/stator": minor
---

The serving layer learns to cache. `/static/*` responses now carry caching headers: the framework's hashed-output namespace `/static/assets/*` (island bundles, emitted URL assets) is served `public, max-age=31536000, immutable` — content-addressed names make a year of caching correct by construction — while every other static file gets an `ETag` (size + mtime) and `Last-Modified` with `public, max-age=0, must-revalidate`, so repeat requests answer with a bodyless 304 instead of the full file. Previously static responses carried no caching headers at all and every request paid for the full body. The dev servers are unchanged — they keep serving `no-cache` so edits always show.

Riding along: `image/avif`, `font/ttf`, and `font/otf` join the static content-type table (they previously fell through to `application/octet-stream`), and catch-all route params — `routes/media/[...path].ts` matching zero or more segments with the raw remainder in `params.path` — are now documented and integration-tested. They have worked since route discovery shipped; the docs never said so.
