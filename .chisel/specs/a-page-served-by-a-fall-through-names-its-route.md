---
title: 'A page served by a fall-through names its route'
status: ready
created: 2026-11-22
updated: 2026-11-22
area: server
---

## What and Why

A page GET tries every route that matches the path: when the first answers 404 it falls through to a catch-all (`[...name]` or `routes/404.stator`), and the catch-all's page goes out (`packages/stator/src/server/http.ts`, the `app.get('*')` loop over `cascadeCandidates`). `/__sse` and `/__events` do not. Both resolve the page's path with `matchPath`, which returns the first match only.

So a page served by a catch-all is synced and patched from the first route's render. That render is a different template with its own slot and element ids, and it is the one that answered 404. A patch can land on the wrong element, and the event gate checks the wrong route's offered events.

Found on 2026-11-22 while building the layout fingerprint, and confirmed there with a probe. With the fingerprint as specced, such a page would be told to reload on every connect and every event, so that branch exempts a render that answers 404 from the comparison. The exemption leaves these pages exactly as wrong as they are on `main`.

Not affected today: tonysull.co has no catch-all or `404.stator` beside a route that sets 404.

## Success Criteria

- A page served by a catch-all after a 404 fall-through gets its initial sync, its patches and its event gate from the catch-all route.
- A page served by its first match sends nothing new and behaves as now.
- The layout fingerprint's 404 exemption is removed; a `routes/404.stator` page with live bindings connects and takes patches without a reload.
- A page naming a route the server does not have for that path reloads once, through the reload guard.

## Constraints

- Patch release. Additive on the wire; an older client or an older cached page sends nothing and gets today's first-match behaviour.
- No extra render per event. Re-running the cascade on `/__events` would render the first route before every event in any app that has a `404.stator`, since that file matches every path.
- The client may only choose among routes the GET cascade could have served for that path.

## Approach

**The page says which route rendered it, only when it was not the first.** `renderGetCandidate` is told whether its route is the first candidate. When it is not, the page head carries

```html
<meta name="stator-pattern" content="/*rest">
```

holding the route's `urlPath`. The client reads it once and, when present, sends it as `&pattern=` on `/__sse` and `X-Stator-Pattern` on `/__events`, beside the route key it already sends.

**The two handlers resolve by it.**

```ts
function resolvePageRoute(matchers: RouteMatcher[], path: string, pattern?: string) {
  const candidates = cascadeCandidates(matchAllPaths(matchers, path).filter((m) => !!m.route.GET))
  if (!pattern) return candidates[0] ?? null
  return candidates.find((m) => routeId(m.route) === pattern) ?? 'stale'
}
```

- No pattern: the first match, as now.
- A pattern among the candidates: that route. Admission, the live check, the event gate, the render and the fingerprint all use it.
- A pattern not among them (`'stale'`: the route was removed or renamed by a deploy): `/__sse` sends the guarded reload frame and ends; `/__events` answers with the reload directive and does not dispatch, since no gate can be evaluated.

`routeId` must be unique per route. `urlPath` may not be: `routes/404.stator` is synthesized as a catch-all and an authored `[...name]` at the same depth could share its shape. Check, and if they can collide, mark the 404 route's id.

**The exemption goes.** `layoutReload` compares every render. A named route that now answers 404 (the post was deleted) fingerprints differently from the page the tab holds, the tab reloads, and the GET falls through properly.

**Trust.** The pattern is client-supplied, and it selects only among `cascadeCandidates` for the path. A caller could name the catch-all on a path the first route serves and so be gated by the catch-all's offered events. It can already do that by sending a route key for any path only the catch-all matches, so nothing widens. Middleware admission is by path and is unchanged.

**A page whose route state changed since the GET.** A tab holding the catch-all's page keeps being patched from the catch-all even if the first route would now serve the path. That is consistent with what the tab shows; a reload picks up the new page.

**Docs.** `WIRE.md`: the new parameter and header. `guides/routing.md`, in the cascade section: one sentence that a page reached by fall-through keeps its live updates and events on the route that rendered it.

**Changeset (patch).** "A page served by a catch-all route after another route answered 404 now gets its live updates and events from the route that rendered it. Before, `/__sse` and `/__events` used the first route matching the path, so such a page was patched from a different template and its events were checked against the wrong route."

## Alternatives Considered

- **Re-run the cascade in both handlers**, as GET does. No wire change and no client input. It costs a render of the first route before every event wherever a second candidate exists, which is every path in an app with `routes/404.stator`.
- **Always send the pattern.** Simpler to describe; adds a meta and a header to every page for a case most pages are never in.
- **Make a 404 terminal.** Removes the fall-through and the bug with it. Breaking; recorded as a 4.0 candidate in the roadmap's ledger, where a route would hand a request on explicitly.

## Open Questions

- **Does this survive the 4.0 candidate?** With an explicit hand-off the page is still served by a route that was not the first match, so the pattern is still needed.

## Implementation Notes

One PR, S. Stacked on `fix/layout-fingerprint`: it edits the same two handlers and removes that branch's exemption.

- `packages/stator/src/server/http.ts`: `resolvePageRoute` replacing `matchPath` in `/__sse` and `/__events`; the meta in `renderGetCandidate`; the exemption removed from `layoutReload`.
- `packages/stator/src/client/runtime.ts`, `client/transport.ts`: read the meta, send the parameter and the header.
- Tests: a fixture with `[slug].stator` (404 for an unknown slug) and a live `[...rest].stator` with root bindings, plus a `404.stator` variant. The served HTML's ids equal the initial sync's; an event the catch-all offers is accepted and one only `[slug]` offers is refused; a first-match page carries no meta; an unknown pattern reloads with `reason: 'layout'` and dispatches nothing; a pattern for a route that does not match the path is treated the same.
