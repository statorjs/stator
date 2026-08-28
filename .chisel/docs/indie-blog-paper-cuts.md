# indie-blog starter — paper-cut log

Evidence artifact, registration-playbook style: friction found while building IndieWeb protocols on the minimal surface, feeding four open threads — collections-of-workflows recurrence, origin-trust, the npm-distribution seam (phase 2), and per-record timers.

Format: what happened → what it cost → what would help. Dated; append as found.

---

## 1. Per-record retry backoff wants per-record timers (2026-08-10, build)

The outbox's failed sends retry only by owner button. Automatic backoff per entry needs a timer per record — `after` is per-STATE, and the machine has one state for all entries. This is collections-of-workflows recurrence #2 (mention verification is occurrence #1 in the same app): the per-record statechart design now has the second real app the revisit trigger asked for.

## 2. Anonymous ingress rides a session gateway (2026-08-10, build) — WORKS, with a wrinkle

The webmention endpoint serves strangers, so RECEIVE lands in a throwaway session machine whose guard is the spec validation, and the app machine subscribes to its emit. It works and reads well — but every anonymous POST mints a session that exists only to carry one guarded emit. Origin-trust evidence: a server-only event ("this route, not the wire") would express this directly, without the ceremony session.

## 3. `<time datetime>` was untyped (2026-08-10, build) — FIXED IN-PR

`ElementSpecificAttributes` had no `time` entry, so the h-entry's `dt-published` timestamp was a compile error. First microformats-shaped app found it within minutes. Added upstream with this starter.

## 4. `raw` must be imported and the error doesn't say so (2026-08-10, build)

`raw()` is deliberately not a template global (authors import it — good rule), but the failure is a bare `Cannot find name 'raw'` from the check file. A located "import raw from @statorjs/stator/template" hint would turn a head-scratch into a fix. Docs/diagnostic polish, not surface.

## 5. The self-webmention wire test needed a real port (2026-08-10, build) — GOOD

Verification effects fetch over real HTTP, so the wire test listens on a port and the blog webmentions itself: post B links to post A, the endpoint 202s, the effect fetches B's live page, the mention flows through moderation to A's page. `DevApp.listen` + effects made a no-mock full-protocol test in ~30 lines — this is the pattern collections apps should copy.

## 6. Deferred by decision, logged for the next cut (2026-08-10)

Mention updates/deletes (the spec allows re-sent mentions to modify earlier ones — the starter dedupes), a real mf2 parser (classification is regex-lite), and re-verification timers. None blocked the loop; all are good second-PR material alongside Micropub and the IndieAuth provider.

## 7. A5 baseline: every anonymous read mints a session (2026-08-27, measured) — THE CACHING EVIDENCE

Measured on the production path (`stator build` + `stator start`, in-memory store, empty index — render cost is the floor, not typical): cold GET / 11.7ms; warm anonymous median 0.4ms, p95 1.1ms; sessioned median 0.3ms. The load-bearing numbers: **500/500 cookie-less GETs carried Set-Cookie (100% mint a session)** and process RSS grew **~36KB per anonymous request** (+17.8MB over 500). Extrapolated: a crawler or a cookie-stripping CDN doing 100k requests parks ~3.5GB of session state until the 24h TTL. Script: `examples/indie-blog/scripts/measure-read-path.mjs`. This is the quantified case for lazy session establishment + derived Cache-Control (the read-path spec): the render is already fast — the cost is the state we mint for visitors who never needed any.

## 8. A1 fonts: the recipe works end-to-end; the metrics step is the real friction (2026-08-27, build)

Self-hosting Literata from `@fontsource-variable/literata` needed: a 15-line copy script (`scripts/sync-fonts.mjs`, wired to `predev`/`prebuild` — the step a `fonts` config would own), hand-written `@font-face` pairs, and the preload with its `crossorigin` gotcha. All fine. The genuine friction was the **metrics-adjusted fallback**: the numbers require external data (`@capsizecss/metrics` — whose org name is non-obvious; the first guess at the package 404'd) plus the fontaine formula applied by hand (size-adjust 107.67%, ascent 109.31%, descent 28.61% for Literata-over-Georgia). This is the part worth first-classing if a `fonts` config ever ships: generate the fallback face, not just copy files. Two more notes: the synced files are gitignored so tests must run the sync themselves (`predev` doesn't cover vitest); and the 2.8 static headers held up — the woff2 serves with `font/woff2` + ETag revalidation out of the box.

## 9. Photo posts: multipart and the catch-all needed zero framework work (2026-08-28, build)

The repo's first file upload: `request.formData()` handled multipart natively (a `File` arrives, an empty file input is a zero-byte part you filter), the cross-site guard passed it unchanged, and the dated media URLs rode the catch-all param exactly as documented. The only friction was already predicted: raw `Response`s get no free ETag, so the media route hand-rolls conditional-GET (~10 lines — more promotion evidence for the image route, which would own this). One app-level gotcha for test authors: login rotates the session, so a test client must adopt the new `stator_sid` after authenticating. Still open from the spec: no framework body-size limit exists — the 10MB cap is enforced in the handler.

## 10. Image variants + Image/Picture: zero compiler friction, one design insight worth promoting (2026-08-28, build)

The Astro-v1 API shape (`getImage()` under `<Image>`/`<Picture>` components) mapped onto `.stator` components with no framework fight: a component wrapping a component, `each` over a derived array emitting `<source>` elements, typed props with destructure defaults — all first try, and the repo's first `<picture>` compiled and typechecked clean. The insight the framework `<Image>` should keep: **intrinsic dimensions are write-time data** — probed once at upload by the handler (async is fine there) and stored on the row — because the synchronous-frontmatter contract makes render-time probing impossible, which turns out to be the right architecture anyway (no per-render IO, CLS attributes from plain columns). The variant endpoint's whole contract fit in ~60 lines of example code: extension = delivery format (transcode to honor it, never lie), width allowlist against resize-DoS, disk cache invalidated by original mtime, hand-rolled 304s (the thrice-logged raw-Response ETag gap).

## 11. Migrating onto the framework image surface: three API findings in an hour (2026-08-28, build)

The migration itself was the satisfying kind — `routes/media/`, `lib/images.ts`, and both components deleted, `lib/media.ts` halved, all 36 tests green with their original assertions. What the dogfood caught: (1) `probeImage` first shipped taking the resolved images config, which an upload handler doesn't hold — flattened to `(bytes, transformer?)` before the PR ever landed; (2) `defineConfig` isn't importable from the package root (`@statorjs/stator` has no `.` export) — the `/config` subpath works but the root is the first thing anyone types; (3) in-process test boots (`createDevApp`) don't read `stator.config.ts` — the CLI loads it — so tests duplicate the images config by hand, the same seam the pinned wire tests already document; and (4) an app *script* can't import the raw-TS framework under plain `node` (the CLI loader isn't registered outside `stator` commands) — `tsx` covers it, but "scripts that use framework helpers" is a real shape with no first-class answer.
