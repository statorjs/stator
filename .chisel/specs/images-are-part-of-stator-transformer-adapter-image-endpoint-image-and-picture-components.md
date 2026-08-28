---
title: 'Images are part of Stator: transformer adapter, image endpoint, Image and Picture components'
status: draft
created: 2026-08-27
updated: 2026-08-27
area: runtime
---

## What and Why

Promotion of the image support proven in `examples/indie-blog` (PRs #139/#140; paper-cut log entries 7–10) into framework surface. The adjudication is GO on the evidence: the app-level build had zero compiler friction, the API lineage (Astro's first image integration, which Tony built) held up, and the gap is live in production publishing stacks (srcset scaffolding without real variants). This spec assembles the already-adjudicated decisions and settles the few genuinely new ones; the build ships as one minor whose changelog story is "images are part of Stator."

Decisions carried in from the Stage A spec (all Tony-adjudicated, 2026-08-27/28):

- sharp becomes a **direct framework dependency behind a generic transformer adapter** — the default implementation is swappable, the seam shaped like `bundleIslands` (pure inputs→outputs, one-impl swap).
- **The URL's extension is the delivery format** — never `Accept`-header or UA negotiation; requesting `.png` can never yield webp bytes; the endpoint transcodes to honor the extension.
- **Dimensions doctrine**: store-owned images carry intrinsic dimensions probed at WRITE time (upload), so the synchronous render never does image IO; a remote `src` requires declared `width`+`height` or an aspect ratio as a TYPE-LEVEL requirement, not a runtime warning.
- The root **`media/` convention directory is NOT in this minor** — claiming it is breaking (apps may own a root `media/` today); it rides the next major via major-cutover-pairing. This minor is config-pointed.
- `loading="lazy"` + `decoding="async"` defaults with a **`priority`** escape hatch (`eager` + `fetchpriority=high`) — encoding the two-mode best practice; no preload links (scanner-discovered `<img>` needs `fetchpriority`, not preload).
- GIFs pass through as originals only (animation does not survive naive resizing).

## Scope

**1. The transformer adapter (`ImageTransformer`).** A small interface the framework owns: `probe(source) → { width, height }` and `transform(source, { width?, format }) → bytes` (exact shape settled at build). Sharp is impl #1 and the direct dependency; the adapter exists so a different library (or a remote transform service) can replace it without touching the endpoint or components. Lazy-imported so image-free apps never load sharp.

**2. The image endpoint.** Framework-registered (like `/static`), **mounted only when configured** — `images: { dir }` in `stator.config.ts` enables it; absent config, zero route-space claim (fully non-breaking; `examples/indie-blog` today owns its own `/media` route, which the follow-up example PR deletes in favor of this). Contract proven in the example: catch-all dated paths, extension = delivery format, `?w=` from a width allowlist (`images.widths`, default `[400, 800, 1200, 1600]`), disk-cached variants beside the originals invalidated by original mtime, strong ETag + bodyless 304 (framework-owned now — retiring the thrice-logged raw-Response-no-ETag paper cut for this path), `Cache-Control: public, max-age=0, must-revalidate`.

**3. `getImage()` + `<Image>`/`<Picture>` on the stable `components` subpath** (JsonLd precedent). `getImage(opts)` is pure math over provided dimensions → `{ src, srcset, width, height }`. `<Image>`: one `<img>` with required `alt`, width/height always emitted (CLS), srcset over the endpoint, lazy/async defaults, `priority` mode. `<Picture>`: modern-format `<source>` chain (`formats` default `['avif','webp']`) over the same contract with `<Image>` as fallback. Props generalize the example's `post`-bound shape to `src`/`width`/`height`/`alt`/`sizes`/`widths`/`format(s)`/`priority`.

**4. The dimensions typing.** `src` pointing into the configured store may omit dimensions ONLY where the caller provides them from data (the example's write-time rows); a remote URL `src` type-requires `width`+`height` (or `aspectRatio`). Mechanics live in the props union (`href?: never`-style discrimination is the house pattern precedent).

**5. The write-time probe.** Exposed via the adapter (`probe`) so app upload handlers store dimensions at ingestion; ingestion itself stays app-side (Micropub media endpoint is the example's declared second PR, not framework surface).

**6. Docs + release furniture.** The styling-and-assets "not a framework feature today" images paragraph is replaced by the real story; reference page for the config/components/adapter; changelog story + landing-ledger entry ride the PR (the release-story-rides-the-release-PR pattern).

## Out of scope

Root `media/` convention dir (next major); Satori/OG image generation (separate thread); any import-graph/bundler image handling (never — the governing no-plugin-surface rule); upload/ingestion endpoints (app-side; Micropub is the example's Stage B); a framework body-size limit (server hardening — separate patch candidate); remote-image fetching/proxying (the endpoint serves the configured store only — proxying remote origins is an SSRF surface this minor does not open).

## Success Criteria

- An app adds `images: { dir: 'media' }` + drops `<Image src… />` in a template and gets variants, srcset, CLS-safe markup, and 304s with no app-level image code.
- `examples/indie-blog`'s follow-up PR deletes its `lib/media.ts` variant machinery, `lib/images.ts`, and both components in favor of framework surface, with its photo tests still green — the evidence-before-primitives loop closing.
- An unconfigured app has zero new routes, zero sharp in its module graph, and byte-identical behavior.
- The dimensions requirement on remote images is a compile error, verified in the template-check tests.

## Open Questions

- Endpoint URL space: serve under the configured dir's own name (`/media/...` when `dir: 'media'`) or a fixed framework path? Leaning configured-name — it matches the example and keeps URLs stable through the eventual major's convention-dir default.
- Whether `images.widths` allowlist doubles as the default `widths` for `getImage`'s srcset (leaning yes — one list, two consumers).
- Adapter caching contract: does the framework own the disk cache around the adapter (leaning yes — adapters stay pure transforms), or may an adapter claim caching (a remote service already has its own)?
