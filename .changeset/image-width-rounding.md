---
'@statorjs/stator': minor
---

The image endpoint answers a width that is not in `images.widths` instead of refusing it. `?w=120` with `[192, 400, 800]` redirects to `?w=192`, the next width up; a width past the largest redirects to the original in the requested format. Before, both were a `400`, which a browser shows as a broken image. Crops round the same way and keep their shape, stopping at the largest width. No new variants exist: the redirect lands on a listed width's URL. A malformed width (`400.0`, `0`, `abc`) is still a `400`. `servedWidth(widths, requested)` is exported from `@statorjs/stator/server` for code that builds image URLs.
