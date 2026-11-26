---
title: 'An unlisted image width is answered by the next one up'
status: ready
created: 2026-11-26
updated: 2026-11-26
area: server
---

## What and Why

The image endpoint refused any `?w=` that was not in `images.widths` with a `400`. A browser shows a 400 on an `<img>` as a broken image, so one wrong number in a template breaks every image it renders, and nothing before production says so.

That happened on tonysull.co on 2026-11-26. IndiePub's response pile built each face's URL with `avatarSrc(photo, 64)`, which produces `/media/remote/<hash>.webp?w=64`. The site's `images.widths` is `[192, 400, 800, 1200, 1600]`. Thirty of the 31 faces sampled across the archive were broken images until the template was changed to ask for 192. The helper that built the URL lives in a package, only builds a string, and cannot see the site's list. Its tests asserted the URL's shape, not that a site would serve it.

The allowlist itself is right: variants are encoded on demand and cached on disk, and an open width would let anyone make the server encode and store an unlimited number of files. What was wrong is the answer to a width off the list. The caller wants an image of about that size, and the list always holds a good answer.

## Success Criteria

- `?w=120` with `widths: [192, 400, 800]` yields the 192 variant.
- A width between two listed widths yields the larger of the two.
- A width past the largest listed width yields the original at its own size, in the format the URL's extension names.
- No request for an unlisted width creates a file in `.variants/` that a listed width would not create.
- A CDN in front holds one copy of each variant's bytes, however many widths were asked for.
- A malformed width (`400.0`, `4e2`, `0`, `abc`) is still a `400`.

## Constraints

- The variant space stays `|widths| x |aspects|` plus the original per format.
- "One spelling per width, so a CDN holds one copy of each variant" is an existing, tested property of the endpoint. Rounding must not weaken it.
- Never round down: a smaller image than asked for is visibly soft, a larger one only costs bytes.

## Approach

`serveImage` resolves a requested width to the rung that answers it with `servedWidth(widths, requested)`: the smallest listed width that is at least the requested one, or `null` past the largest.

When the rung differs from the requested width, the endpoint answers `302` with `Location` set to that variant's own URL: `…?w=<rung>`, or the path with no query when the original answers. The redirect carries `Cache-Control: public, max-age=3600`. It is safe to cache because a stale redirect still names a URL the endpoint resolves: every width resolves now.

Crops (`?w=&h=`) round the same way. The pair must still match an allowlisted aspect as given. The width then rounds up and the height is recomputed from that aspect. Past the largest width a crop becomes the largest width's box, not the original, because a crop promises a shape and the original does not have it.

`servedWidth` is exported from `@statorjs/stator/server`, so code that builds image URLs outside `<Image>` can pick the rung itself and skip the redirect.

## Alternatives Considered

- **Serve the rounded variant directly on the unlisted URL (200).** One round trip fewer on a cold cache. Rejected for now because every distinct `?w=` would then be its own cache entry at a CDN and in the browser for the same bytes, which is the property the canonical-spelling check exists to protect. It is a small change to switch if the extra hop proves to matter.
- **Keep the 400 and catch the mistake in `stator check`.** A type generated from `images.widths` would catch literal widths passed to Stator's helpers. It cannot catch a computed width or a URL built as a string, which is what caused the incident. Still worth doing on its own; it does not replace this.
- **Round to the nearest width, up or down.** Rejected: rounding down serves a soft image.

## Open Questions

- Should `stator dev` log a warning when it redirects an unlisted width, so the template gets fixed and the hop goes away?
- Should the render state's widths be reachable by a package, so a helper like IndiePub's `avatarSrc` can call `servedWidth` with the site's list?

## Implementation Notes

- `packages/stator/src/server/images.ts`: `servedWidth`, `canonicalRedirect`, and the size validation at the top of `serveImage`.
- `packages/stator/tests/images-endpoint.test.ts`: the redirect targets, the no-new-variant check, and crop rounding.
- With an empty `images.widths`, every `?w=` redirects to the original and a crop is a `400`.
