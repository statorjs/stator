---
title: 'SEO surfaces: route head-as-data, runtime sitemaps, and the revision hook'
status: draft
created: 2026-08-29
updated: 2026-08-29
area: architecture
---

## What and Why

Recorded 2026-08-30 from the tonysull.co pre-cutover review. Every framework answers SEO somewhere on a spectrum — Next's maximal Metadata API + file conventions, Nuxt's module family, Astro's build-time sitemap integration, SvelteKit's write-it-yourself endpoints. The dogfood built the full surface app-side (robots/sitemap data routes, layout prop-threaded head, satori OG route, shipped JSON-LD component) and the paper cuts sort cleanly into tiers.

## Tier 0 — the recipe (ships first)

Robots and sitemaps as data GET routes (free ETag/304), layout-owned head markup, the JSON-LD body component, satori OG generation as app code (the images spec already adjudicated OG generation OUT of framework scope — that holds). One docs recipe: "SEO for your site". Honest SvelteKit-tier; livable, proven.

## Tier 1 — `Stator.head({...})` on routes (the one primitive with evidence)

Route-owned head-as-data: `Stator.head({ title, description, canonical, og, … })` in ROUTE frontmatter — routes only, exactly like `Stator.reads`. Rendered through the `</head>` injection seam the framework already owns (`headExtras`, the `stator-live`/`stator-build` metas). Layout markup keeps owning defaults (fonts, styles, fallback title); `head()` emits page tags with dedupe-by-name/property, route-wins.

Evidence: THREE apps hand-built the same layout prop-threading (`title/description/canonicalPath/ogImage` — weather, indie-blog, tonysull.co). This is distinct from the head-contributions-from-components note, whose promotion trigger (a COMPONENT owning head-worthy knowledge) has still not fired — but the object shape here is deliberately that note's shape, so if components ever earn head access it is the same API extended down the tree, not a second system. Data-not-markup keeps it analyzable for the introspection manifest.

Deliberately excluded: Next-style layout-tree metadata inheritance (merge stays flat at the route level); any config `site:{}` identity block (layout markup is the default-owner — config owns how it runs, not what it says).

## Tier 2 — runtime sitemaps: no enumerator protocol

Astro's sitemap integration reads the BUILD output — which fails exactly where a server-canonical site lives: posts publish without a rebuild. The tempting fix is a runtime `getStaticPaths` analog (per-route `entries()` exporters the framework calls to expand dynamic patterns). REJECTED: it re-imports a build-era concept, invents a second data-access path, and answers a question the app can already answer better — **the app's own store query IS the enumeration**. A blog knows its slugs; a shop knows its products; the framework cannot know either, at build OR runtime.

What the framework contributes instead:
1. **`staticRoutePaths()`** — the param-free half of the route table, read from route discovery. Third consumer of the route-table read (after the reserved-slug derivation and the `stator check` shadow-lint idea) — this is the introspection-manifest thread accruing evidence, not a new subsystem.
2. **`sitemapXml(urls: Array<string | { loc, lastmod? }>)`** — a formatter, nothing more. The sitemap stays a NORMAL data route the app writes: `sitemapXml([...staticRoutePaths().map(abs), ...listEntries().map(e => ({ loc: e.url, lastmod: e.updatedAt }))])`.

No magic file conventions; the drift-proofing lives in deriving the static half from the same route table the app's URLs already answer to.

## The revision hook — cheap "no change" without invoking the handler

The second question a runtime sitemap raises: a polling crawler shouldn't cost a full XML build per probe. Today data routes get a FREE body-hash ETag — but the hash requires RUNNING the handler. The designed-but-unpromoted upgrade in the data-routes spec ("revision-ledger 304 without invoking the handler") is exactly this seam, and it now has concrete consumers:

```ts
export const GET = defineApiRoute({
  method: 'GET',
  revision: () => String(maxEntryUpdatedAt()),   // one indexed SELECT
  handler: () => sitemapXml(…),                  // never runs on a match
})
```

Semantics: `revision()` returns a cheap string/number; the framework derives the ETag from it and answers `If-None-Match` with a bodyless 304 BEFORE the handler. Consumers in hand: the sitemap AND all three feeds — paper-cut #7 measured ~36KB of RSS re-rendered per anonymous crawler hit; `max(updated_at)` (which soft-deletes also stamp, so deletions bust it correctly) reduces a poll to one indexed SELECT. Composes with, not replaces, CDN caching: the revision answers the origin-side cost for however much polling still reaches the origin, and later the reads-graph surrogate keys purge the CDN copy the moment a commit changes the revision.

## The differentiator worth writing into docs

Server-canonical flips the SSG trade: metadata is always live (no rebuild staleness), and with read-path layer 3 + surrogate keys, sitemaps/feeds/OG tags become CDN-cached yet purged the instant a post publishes — "never-stale SEO" as a story static-first frameworks structurally cannot tell.

## Sequencing

Recipe (Tier 0) → `revision()` on data routes (small, two consumer classes waiting) → `Stator.head` (own design round on the merge rules, shared shape with the components note) → `staticRoutePaths()`+`sitemapXml()` when a second app copies the recipe (the promotion bar).
