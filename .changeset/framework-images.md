---
"@statorjs/stator": minor
---

Images are part of Stator. Declaring `images: { dir }` in `stator.config.ts` mounts an image endpoint over that directory — the URL's extension picks the delivery format, widths and crop aspect ratios come from allowlists, variants cache on disk with content-hash ETags and bodyless 304s, and transformation runs through a swappable `ImageTransformer` adapter (sharp by default, lazy-loaded only when configured).

`<Image>`, `<Picture>`, and `getImage()` ship on the `components` subpath: CLS-safe markup with required width/height sourced from write-time data (`probeImage()`), `srcset`/art-direction over the endpoint, lazy-loading defaults with a `priority` escape hatch, and crop/format handling for SVG, GIF, and EXIF-oriented photos. Encoding is tuned for small hosts out of the box (bounded concurrency, a libvips thread cap, an encode-timeout fallback to the original).

Proven end-to-end in `examples/indie-blog` before promotion; the example migrates onto this surface in a follow-up.
