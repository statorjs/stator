---
"@statorjs/stator": minor
---

The framework knows your static pages — the cacheable read path, layers 1+3.

**Lazy sessions (layer 1).** A session is established only when something needs one: a dispatch into a session machine, a session-machine read in a route's `reads`, an SSE connect, or an explicit session op (`setClaims`, `rotateSession`, dev inspect). Anonymous GETs — pages, feeds, data routes, static, images — no longer mint a session or set a cookie, so a CDN is finally allowed to cache them and a crawler no longer parks per-hit session state (the measured cost: every cookie-less GET wrote a session; ~3.5GB per 100k crawler hits). An arriving `stator_sid` cookie resumes its session exactly as before — laziness governs creation only, and `claims()` is a peek that never establishes (middleware gates keep working on anonymous probes).

**Derived Cache-Control (layer 3).** On GET responses the framework can PROVE anonymous-identical — every declared read app-lifecycle, no session use or claims read while handling, no hand-set headers or cookies — it emits `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` (tune or disable via `caching` in `stator.config.ts`; hand-set headers always win; dev servers never emit so editing always re-renders). Pages that read session machines are never marked, structurally.

**Migration notes.** Test suites that harvested a sid from a first GET's `Set-Cookie` must mint their own (`stator_sid=<uuid>` resumes verbatim — pre-existing semantics) or take it from a login/dispatch response. A login that establishes and rotates in one request now emits two session Set-Cookies; browsers correctly keep the last — header-parsing helpers should too.
