---
"@statorjs/stator": minor
---

SVG serves through the image endpoint as an originals-only format: no resizing, no rasterizing to other formats, no fabricating an SVG from a raster — and every SVG response carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` plus `nosniff`, so an uploaded file's embedded scripts are inert on direct navigation while `<img>` and favicon uses are untouched.
