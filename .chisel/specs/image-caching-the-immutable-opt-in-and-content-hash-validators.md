---
title: 'Image caching: the immutable opt-in and content-hash validators'
status: draft
created: 2026-08-30
updated: 2026-08-30
area: server
---

## What and Why

Recorded 2026-08-30 from the tonysull.co staging soak. The image endpoint emits `public, max-age=0, must-revalidate` on every 200 (originals and variants) with a size+mtime ETag of the served file. That is the correct conservative default — the framework cannot assume a URL's bytes never change, since an app may replace an original in place under the same path — but it forfeits nearly all HTTP caching: browsers revalidate every image on every use (one conditional GET per image per page view; cheap 304s but a full RTT each), and CDNs treat `max-age=0` as uncacheable (Cloudflare skips it without an edge-TTL override rule). Two production facts sharpen the cost: (1) tonysull.co is likely deploying WITHOUT a caching CDN — Fly's anycast proxy caches nothing — so the browser cache is the only cache there is, and (2) this app's uploads are write-once by construction (nanoid names, recovery files under fresh uuid paths; a replaced image is a NEW url), so it pays the revalidation tax against a hazard it structurally cannot have.

A second, independent defect hides in the current validator: the ETag is `size-mtime` of the served FILE. Every volume reseed (tar/sftp resets mtimes) silently changes every ETag and busts every visitor's cache of every image, and every variant re-encode does the same for that variant, even when bytes are identical. The freshness check for variants (`cache.mtime >= original.mtime`) has the dual failure: an mtime-preserving copy can leave a stale variant looking fresh.

## Part A — `images.immutable: true` (the opt-in assertion)

One boolean on the images config. It is the APP asserting a contract the framework cannot infer: "the bytes behind an image URL never change; replacement means a new URL." When set, 200s (originals and variants) emit `public, max-age=31536000, immutable` instead of the revalidation default. ETags stay (harmless, and useful for cold-cache conditional requests). The encode-deadline 302 keeps its `no-store` — a temporary fallback must never stick anywhere.

Why opt-in and not default: an app that overwrites `avatar.jpg` in place would serve year-stale images to every prior visitor with no recourse — no header can un-cache an `immutable` response. The docs sentence is the contract: enable this only if your upload path generates fresh names, and treat enabling it as promising that forever.

## Part B — content-hash validators (replaces size-mtime)

The validator becomes a content fingerprint: `"<sha1-16 of ORIGINAL bytes>"` for originals, `"<sha1-16 of original>-<w>[x<h>]-<fmt>"` for variants. The original's hash is computed once and memoized in-process keyed by `(path, size, mtime)` — mtime demotes from identity to a cheap cache key, which is its correct role. Variants never need their own bytes hashed: a variant is a pure function of (original bytes, transform params, encoder), so the composite key IS its identity — and it means the 304 path can answer without the variant file existing at all.

What this fixes regardless of Part A: reseeds and re-encodes stop busting caches (same bytes → same ETag through any mtime churn), and in-place replacement becomes correctly self-busting under the DEFAULT mode (next revalidation misses, fresh bytes flow). The variant freshness check moves to the same fingerprint (compare the variant's recorded source-hash, not mtimes), fixing both stale-variant duals. Prior art in-tree: the query-route `revision()` ledger already ships `"r-<sha1-16>"` ETags — same shape, same truncation.

The pairing limit, stated plainly (it was the motivating question): a hash ETag pairs with `must-revalidate`, NOT with `immutable`. An ETag can only bust a cache at revalidation time; under `immutable` clients never revalidate, so no validator — however content-true — reaches them. Busting under long TTLs requires the URL itself to change. Part A and Part B compose (better validators for the cold path, immutable for the hot path) but neither rescues the other's failure mode.

## Part C — versioned variant URLs (deferred)

The only design that gets BOTH long TTLs and in-place busting: `getImage` stamps `?v=<hash8>` into every emitted URL, the endpoint treats `v` as opaque cache-busting, and immutable becomes safe unconditionally. Deferred because it needs the render side to know the hash (write-time data or a memoized render-side probe — the same doctrine tension the body-image recipe logged), it widens the URL grammar, and no consumer needs it: the app that replaces originals in place AND wants long TTLs is the promotion trigger, and none exists.

## Sequencing

Parts A+B ride `feat/framework-images` while 2.9.0 is unreleased — header and validator semantics are contract surface, cheaper to settle before the freeze than after. tonysull.co adopts `immutable: true` at next deploy (write-once uploads; CDN-less, so the browser-cache win is the whole win) and the soak becomes the evidence. Part C parks with its named trigger.

## Open questions

- Hash algo/length: sha1-16 matches `revision()`; collision risk at this scale is irrelevant, but consistency across the two ledgers is worth a shared helper.
- Whether `immutable` should also apply to the endpoint's 304 responses' headers (it should — a 304 refreshes stored response headers).
