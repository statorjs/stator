---
"@statorjs/stator": minor
---

Images are part of Stator. Declaring `images: { dir }` in `stator.config.ts` mounts an image endpoint over the directory: the URL's extension is the delivery format (request `x.webp?w=800` of a stored `x.jpg` and the server converts and resizes to honor it — never `Accept`-header or user-agent negotiation), widths come from an allowlist, variants cache on disk, and every response carries an ETag with bodyless 304 revalidation. Transformation runs through a swappable `ImageTransformer` adapter with sharp as the lazy-loaded default — an unconfigured app mounts no routes and never loads it.

Rendering ships on the `components` subpath: `<Image>` emits CLS-safe markup (`width`/`height` always present, `srcset` over the endpoint, lazy + async defaults, a `priority` mode for the LCP image), `<Picture>` adds modern-format `<source>` chains with the stored format as fallback plus art direction (`sources` — a different cover-cropped geometry per media condition, crossed with every format; the endpoint's `?w=&h=` keeps both axes on the allowlist so the variant space stays bounded), and `getImage()` is the pure resolver beneath both. Dimensions are required, always, and come from data: probe them once at upload with `probeImage()` and store them — renders are synchronous and never do image IO. Remote URLs render untouched and require dimensions like everything else.

The design was proven end-to-end in `examples/indie-blog` before promotion; the example migrates onto this surface in a follow-up.
