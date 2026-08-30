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

## Part A — a freshness DIAL, not an immutable boolean (adjudicated 2026-08-30)

First cut proposed a boolean `images.immutable: true` → `public, max-age=31536000, immutable`. Tony rejected adopting it, and the reasoning generalizes: the failure mode of a year-long immutable response is UNRECOVERABLE from the server — no header un-caches it, and the `?v=` retrofit is URL churn apologizing for a header you can't take back. The regret asymmetry is the design fact: under-caching costs RTTs you can measure and tune; over-caching costs correctness you can only wait out. A boolean whose wrong setting has no recovery path is the wrong shape for the knob.

The reshape: `images.maxAge` (seconds, default 0 — today's exact behavior preserved) and `images.staleWhileRevalidate` (seconds, default 0). Emission: `maxAge 0` + no SWR → today's `public, max-age=0, must-revalidate`; SWR > 0 → `public, max-age=<a>, stale-while-revalidate=<s>` (must-revalidate dropped — it forbids exactly what SWR permits); an `immutable` marker is appended ONLY when the app additionally passes `immutable: true` on top of a long maxAge — kept in the design space for the truly content-addressed, carrying the no-recovery warning in its docs sentence. The encode-deadline 302 keeps `no-store` regardless.

The sweet spot this exposes — and the likely tonysull.co posture — is `max-age: 0, staleWhileRevalidate: 86400`: repeat views render instantly from cache, the browser revalidates in the background, and with Part B's hash validators that revalidation is CORRECT (an in-place change heals on the next view, not never). Bounded regret: the worst case is one stale render followed by self-repair. It also rhymes deliberately with the read path's derived `Cache-Control` on HTML — the same SWR philosophy on both surfaces.

## Part B — content-hash validators (replaces size-mtime)

The validator becomes a content fingerprint of the ORIGINAL's bytes. The entropy analysis (Tony's question, 2026-08-30): ETags are per-URL — caches never compare validators across URLs — and the transform config (w, h, format-as-extension) IS the URL, so the params contribute no validator entropy. The only thing that can change under a fixed URL is the original's content: `hash(original)` is complete. A `-<w>[x<h>]-<fmt>` suffix may ride along purely as labeling (reading a 304 in devtools), explicitly not load-bearing. The hash is computed once and memoized in-process keyed by `(path, size, mtime)` — mtime demotes from identity to a cheap cache key, which is its correct role. Variants never need their own bytes hashed: a variant is a pure function of (original bytes, URL params, encoder) — and the 304 path can answer without the variant file existing at all.

The one hidden dimension under a fixed URL is the ENCODER: a sharp/libaom upgrade produces byte-different output for the same original and params. Deliberately excluded from the hash — including it would mass-bust every cached image on every framework upgrade for visually identical pixels. The pedantic consequence is owned honestly: a strong ETag promises byte-identity, which encoder drift breaks, so variants emit WEAK validators (`W/"…"` — semantically equivalent is exactly what weak means) and originals stay strong (their hash genuinely covers the served bytes). The existing If-None-Match comparison already strips `W/`.

The same fingerprint drives the disk cache, replacing mtime comparison with a naming trick: the source-hash goes IN the variant cache filename (`<base>-<hash8>-<w>[x<h>].<fmt>`). Freshness becomes a pure existence check — original changed → different name → miss → re-encode — no sidecar metadata, and stale-hash siblings are identifiable garbage (sweep opportunistically on write, or leave for a future `stator images gc`).

What this fixes regardless of Part A: reseeds and re-encodes stop busting caches (same bytes → same ETag through any mtime churn), and in-place replacement becomes correctly self-busting under the DEFAULT mode (next revalidation misses, fresh bytes flow). The variant freshness check moves to the same fingerprint (compare the variant's recorded source-hash, not mtimes), fixing both stale-variant duals. Prior art in-tree: the query-route `revision()` ledger already ships `"r-<sha1-16>"` ETags — same shape, same truncation.

The pairing limit, stated plainly (it was the motivating question): a hash ETag pairs with `must-revalidate`, NOT with `immutable`. An ETag can only bust a cache at revalidation time; under `immutable` clients never revalidate, so no validator — however content-true — reaches them. Busting under long TTLs requires the URL itself to change. Part A and Part B compose (better validators for the cold path, immutable for the hot path) but neither rescues the other's failure mode.

## Part C — versioned variant URLs (deferred)

The only design that gets BOTH long TTLs and in-place busting: `getImage` stamps `?v=<hash8>` into every emitted URL, the endpoint treats `v` as opaque cache-busting, and immutable becomes safe unconditionally. Deferred because it needs the render side to know the hash (write-time data or a memoized render-side probe — the same doctrine tension the body-image recipe logged), it widens the URL grammar, and no consumer needs it: the app that replaces originals in place AND wants long TTLs is the promotion trigger, and none exists.

## Sequencing

Parts A+B ride `feat/framework-images` while 2.9.0 is unreleased — header and validator semantics are contract surface, cheaper to settle before the freeze than after. tonysull.co's candidate posture is the SWR dial (`staleWhileRevalidate: 86400`, maxAge 0) rather than immutable — instant repeat views, background self-healing, bounded regret — decided on soak evidence; CDN-less on Fly, the browser-cache win is the whole win. Part B lands regardless of any dial setting (it is a correctness fix to the validators, not a caching policy). Part C parks with its named trigger.

## Open questions

- Hash algo/length: sha1-16 matches `revision()`; collision risk at this scale is irrelevant, but consistency across the two ledgers is worth a shared helper.
- Whether `immutable` should also apply to the endpoint's 304 responses' headers (it should — a 304 refreshes stored response headers).
