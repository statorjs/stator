---
title: 'A claims read always withdraws derived caching'
status: ready
created: 2026-11-22
updated: 2026-11-22
area: server
---

## What and Why

A page or data route that reads claims and gets nothing back is marked `public`. `readClaims` (`packages/stator/src/server/session.ts:64-66`) sets `claimsRead` only when the claims are defined, on the reasoning in its comment: "a visitor whose claims read came back empty saw exactly the anonymous page". That is true of the response. The header it produces is a statement about the URL:

```
Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
```

with no `Vary` and no cookie. A shared cache that stores it may serve it to any later request for that URL, including one from a signed-in visitor, for whom the origin would have rendered something else.

Reproduced on 2026-11-22 (tests under `packages/stator/tests/repro-cached-claims-sync.test.ts` and `tests/fixtures/cdn-repro/` in the worktree `.claude/worktrees/agent-a2b1f92db79560741`, uncommitted):

- In every variant the signed-in visitor gets the anonymous HTML, with no error, for up to `s-maxage` plus the stale window.
- When the two renders allocate different slot or element ids from the same scope (a plain `claims ? <a/> : <b/>` or `claims && <i/>` with machine bindings in an arm and shared bindings after it), patches computed for the signed-in render land on the wrong elements of the anonymous HTML. The fixture ends up showing "Total: 42" where the total is 7. `when()`/`match()` arms are id-scoped, so their patches miss with a console warning instead.
- A live page is not required. A non-live page gets the same mis-targeted patches on every `/__events` response.
- It is not a cross-user leak: the misplaced data comes from the visitor's own session render.

Checked against production on 2026-11-22: tonysull.co's Cloudflare zone answers `HIT` for the home page on a request that carries a cookie, so the precondition holds on a real deployment. The site is not affected only because `routes/[slug].stator` reads claims for gated posts alone and hand-sets `Cache-Control: private, no-cache` on those, with a comment that describes this bug. Its deploy notes state the contract the framework is meant to keep: "No cookie clause is needed — the framework withdraws `Cache-Control` from any response that varied by visitor."

The fix makes that sentence true: reading claims withdraws the proof, whatever the read returns.

## Success Criteria

- A GET whose handling called `claims()`, from a route's `request.claims()` or from middleware's `stator(c).claims()`, never carries a derived `Cache-Control`, for an anonymous visitor, a cookied visitor without claims, and a signed-in visitor alike.
- The same holds for data GET routes (`server/query-route.ts:163` reads the same flag).
- A hand-set `Cache-Control` still wins, so an app that fronts its origin with a cookie-bypass rule can restore caching for a claims-reading page on purpose.
- The reproduction's anonymous GET of `/shift`, `/when-branch`, `/text-only` and `/shift-static` has no `Cache-Control`.
- The docs state the rule without the "that resolved to a value" exception.

## Constraints

- Patch release. No API change.
- It reduces caching and never widens it: the only observable change is a missing `Cache-Control` on responses that had one.
- No reliance on `Vary: Cookie`. It is correct by RFC 9111, but it depends on the cache honouring it and it splits the cache per cookie value.

## Approach

`packages/stator/src/server/session.ts`:

```ts
/** Read the resumed session's claims — a peek that never establishes. Any
 *  read makes the response claims-dependent (layer 3): the page that came
 *  back may be the anonymous one, but the URL now has more than one answer,
 *  and a derived `public` would let a shared cache give this one to a
 *  visitor who is signed in. */
export function readClaims<T = unknown>(c: Context): T | undefined {
  sessionUse(c).claimsRead = true
  return getSessionState(c)?.claims as T | undefined
}
```

Nothing else in the proof changes. `deriveCacheControl` (`server/http.ts:1105-1113`) and the data-route equivalent (`server/query-route.ts:163`) already require `!use.claimsRead`. All three callers go through `readClaims`: `request.claims()` on page routes (`server/route-request.ts:47`), `claims()` on command routes (`server/api-route.ts:80`, never cached anyway), and `stator(c).claims()` in middleware (`server/context.ts:78`).

**What changes for an app.**

- A page that reads claims is no longer marked for anonymous visitors. It is served from the origin on every request, as it already was for signed-in visitors.
- **Middleware that reads claims on every request withdraws derived caching from every page.** The framework cannot tell a read that only gates `/admin` from one that changes the body, so it does not try. Middleware should read claims only on the paths that need them, which is how `examples/with-auth/middleware.ts` is already written (it calls `s.claims()` inside the `/profile` path check).
- An app that wants a claims-reading page cached and knows its cache bypasses on the session cookie sets the header itself: `Stator.response.headers.set('Cache-Control', 'public, s-maxage=60')`. Hand-set always wins. The responsibility for the cache's behaviour is then the app's, in the open.
- An app that hand-set `private` to work around this (tonysull.co, `routes/[slug].stator`) can delete the line.

**Docs.** `apps/docs/src/content/docs/reference/config.md` (Notes, "Derived caching is a proof"): "no claims that resolved to a value" becomes "no claims". `guides/middleware.md`: beside the coarse-admission paragraph, one sentence that a claims read withdraws derived caching for that response, so read claims inside the path check. `guides/production.md`, if it restates the rule.

**Changeset (patch).** "A GET that reads claims is never marked `Cache-Control: public`. It was marked when the read found no claims, which let a shared cache serve the anonymous page to a signed-in visitor of the same URL. Pages and data routes that read claims are now served from the origin for everyone; middleware that calls `claims()` on every request withdraws derived caching from every page, so read claims only on the paths that need them. A hand-set `Cache-Control` still wins."

## Alternatives Considered

- **`Vary: Cookie` on claims-reading responses.** The header that says exactly what is true. Rejected as the fix: it works only where the cache honours `Vary` on `Cookie`, and where it does, every distinct cookie string is its own cache entry, so analytics cookies alone destroy the hit rate.
- **Document a required CDN rule** (bypass the cache when `stator_sid` is present) and keep the header. Rejected: a `public` header should be sound for any conforming shared cache. The rule also bypasses for every visitor who has a cart, not only signed-in ones. It remains available to an app that hand-sets the header.
- **Exempt middleware reads.** Middleware that redirects a signed-in visitor away from `/login` changes the response by claims while leaving the anonymous 200 looking cacheable. The same bug, one layer up.
- **Arm-scoped ids for `.stator` ternaries and `&&`**, so a mismatched layout misses instead of mis-targeting. Worth considering separately as defence in depth (see Open Questions); it does not stop the anonymous page being served to a signed-in visitor, and it changes emitted ids.

## Open Questions

- **Can the mis-targeted patches happen with no shared cache at all?** Unverified, from reading the code: a tab holding the anonymous render of a claims-branching live page keeps its DOM when the visitor signs in elsewhere. `rotateSession` hangs up the old connection and the tab reconnects under the new session (3.0.0, "Each browser reconnects with its new cookie"); the initial sync is then computed for the signed-in layout against the anonymous DOM. The same would follow from a back-navigation that restores the anonymous page from the browser's back/forward cache after sign-in. If either reproduces, the fix is on the patch side (a layout fingerprint the page echoes on `/__sse` and `/__events`, with a reload on mismatch, or arm-scoped ids for plain conditionals), not in the cache header. Reproduce before designing.
- **A dev-time note.** `stator dev` emits no derived header, so nothing tells an author that a claims read in middleware cost every page its caching. A one-line log at production start listing routes that never derive, with the reason, would make the proof inspectable. Not part of this patch.
- **Claims in layouts and components.** Chosen on 2026-11-22 as the answer to the IndiePub Admin link, under "the existing 2.12 rule". With this fix, a layout that reads claims makes every page that uses it uncacheable. That item needs a different answer before it is specced; see the plan.

## Implementation Notes

One PR, S.

- `packages/stator/src/server/session.ts`: `readClaims` as above. `SessionUse.claimsRead`'s doc comment, if it repeats the old rule.
- `packages/stator/tests/lazy-sessions.test.ts`: the test "a claims peek that finds nothing keeps the proof, anonymous or cookied" (line 212) inverts: both requests return the anonymous page with no `Set-Cookie` and no `Cache-Control`.
- Promote the reproduction as a regression test: `tests/fixtures/cdn-repro/` and `tests/repro-cached-claims-sync.test.ts` from the worktree, renamed (`tests/claims-read-caching.test.ts`), asserting the missing header on the four fixture routes and, for `/shift`, that the anonymous HTML and the signed-in initial sync disagree on ids (the reason the header must not be there).
- A data-route case: a `defineApiRoute({ method: 'GET' })` that calls `claims()` and gets nothing is not marked.
- A middleware case: `stator(c).claims()` on a path withdraws the header for a page that itself reads nothing.
- Docs as listed. Changeset as above.
- `wire/apply.ts`'s comment at `warnMissing` says a patch "can't land on the wrong content"; correct it to say that holds for `when`/`match`/keyed scopes.
