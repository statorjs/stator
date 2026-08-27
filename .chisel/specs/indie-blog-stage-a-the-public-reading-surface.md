---
title: 'indie-blog Stage A: the public reading surface'
status: draft
created: 2026-08-27
updated: 2026-08-27
area: examples
---

## What and Why

Stage A of the indie-blog/publishing dogfood arc (2026-08-27, direction settled in session): grow `examples/indie-blog` into a complete public reading surface — typography, photo posts with real image variants, and hard numbers on the anonymous read path. The example already runs the social organs (webmention receive/verify/moderate, outbox + syndication, owner desk); what it lacks is exactly what every content site needs on day one and what the framework has no story for: fonts, media, images, and CDN-cacheable public pages.

The strategic frame: the static half of a blog is a commodity; a publishing platform's differentiators (webmentions, federation, syndication, live moderation, memberships) are server-shaped, and on a long-lived server they are machines + effects + SSE rather than integration projects against queues and cron. Stage A makes the commodity half real so the differentiated half stands on it. Stage B (per the example's own README): Micropub + media endpoint + IndieAuth provider. Stage C: POSSE beyond webmention syndication, memberships.

Everything here follows evidence-before-primitives: app-level implementations first, paper cuts logged in `.chisel/docs/indie-blog-paper-cuts.md`, promotion only from the log.

## Scope

**A0 — catch-all route params (framework precondition).** Route files support only single-segment `[name]` params; `[...path]` catch-alls do not exist (verified in `server/route-discovery.ts` — `[id]` → `:id` only). Dated media URLs (`/media/2026/08/x.jpg`) are the common publishing shape, so catch-alls land first as a small framework PR: `[...name].ts` as a terminal segment mapping to a Hono multi-segment pattern, param delivered as the raw remainder string. Extension-composed catch-alls (`[...path].jpg.ts`) are NOT in v1 — a catch-all handler parses the extension itself and returns a raw `Response` with an explicit content type.

**A5 — caching baseline (measure first).** Scripted measurements against the running example: anonymous TTFB cold/warm, `Set-Cookie` behavior on cookie-less GETs, session-store growth under cookie-less load (a CDN stripping cookies mints a session per request — quantify it). Numbers seed the ROADMAP "anonymous read path" investigation.

**The cache-design question to spike (not solve) here:** Stator always sets a session cookie, and a CDN must still be able to cache anonymous requests. Direction from Tony: the CDN ignores the session cookie and keys cache-bypass on a SEPARATE marker cookie indicating an authenticated user (set when claims exist, cleared on logout) — the WordPress-logged-in pattern, expressible in any CDN's config. The Stator-shaped addition: cacheability is *derivable* — a route whose `reads` are all app-lifecycle machines and whose handler never touches claims is anonymous-identical by construction, so the framework can know (and eventually declare, via headers) which pages are safe. Stage A records the design note + measurements; the primitive is a later PR.

**A1 — webfont via `@fontsource/*`.** Self-host one variable face (Literata for prose; UI stays system sans) sourced from its Fontsource npm package — the de facto standard font source (Astro world, next/font-adjacent). The example wires it with a small copy step (package files → `static/fonts/` + `@font-face` css), which doubles as the recipe for the guide. First-class sketch recorded for later: a `fonts` config (e.g. `fonts: ['@fontsource-variable/literata']`) resolved at build/dev — copy files, emit the css, inject preloads through the head pipeline — with metrics-adjusted fallback generation (`size-adjust`/`ascent-override`) as the part that earns first-class status. Stage A computes the metrics by hand and logs the pain.

**A2 — photo posts + media.** A `photo` post kind (`u-photo` microformats), owner-desk compose gains a file input (multipart `request.formData()` — dogfoods the file-uploads recipe), originals stored under `INDIE_BLOG_MEDIA` (default `./media`) with dated subpaths (`YYYY/MM/…`) — served via the A0 catch-all.

**A3 — image variants route, app-level.** Serve resized/re-encoded variants from a route using sharp (example-only dep): width via `?w=`, **format via explicit URL extension — never `Accept`-header or UA negotiation** (decision, Tony 2026-08-27: requesting `.png` must never return webp bytes; the markup does format selection via `<picture>`/`srcset`, the server never lies about an extension). Hand-rolled strong ETag + 304 + long `Cache-Control` (raw `Response`s bypass the data-route ETag machinery — expected paper cut, and the promotion evidence for a framework image route).

**A4 — `getImage()` + `<Image>`/`<Picture>`.** Both a lib function and components, following the API direction of Astro's first image integration (which Tony built; the API held up): `getImage(opts)` resolves src/width/height/format(s) to final attrs (intrinsic dimensions read server-side and cached, `srcset` over the A3 route), `<Image>` renders one `<img>` with required `alt` and width/height always present (CLS), `<Picture>` renders `<source type="image/avif|webp">` fallback chains. App-level in `lib/`+`templates/` first; the friction log shapes the eventual framework `<Image>`.

**A6 — riding along.** `rel=me` links, `u-photo` markup, per-post OG meta. Satori OG images explicitly deferred (Stage C-adjacent).

## Out of scope

Micropub + media endpoint, IndieAuth provider (Stage B — the example README's declared second PR); POSSE beyond existing syndication, memberships, ActivityPub (Stage C); the framework image route and `fonts` config themselves (promotion candidates, built only after the log adjudicates); solving anonymous-page caching (spiked + measured here, designed later).

## Success Criteria

- A photo post published from the owner desk renders with `<Picture>` variants, correct intrinsic dimensions, and 304s on repeat requests.
- The Literata face is live with a metrics-adjusted fallback and no visible layout shift on font swap.
- Catch-all params shipped with tests; dated media URLs work.
- Baseline caching numbers recorded; the marker-cookie design note written.
- Every friction point logged in the paper-cut log with enough detail to adjudicate promotion.

## Open Questions

- Whether `getImage()`'s transformer seam (sharp today) should be pluggable when it promotes, or sharp is simply the answer server-side.
- Where fontsource copy logic belongs long-term: scaffold script, `stator build` step, or config-driven — decided by how the recipe feels in this example.
- Whether the marker cookie is framework-emitted (paired with claims lifecycle) or an app middleware recipe.
