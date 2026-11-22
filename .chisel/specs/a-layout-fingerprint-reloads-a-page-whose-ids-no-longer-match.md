---
title: 'A layout fingerprint reloads a page whose ids no longer match'
status: ready
created: 2026-11-22
updated: 2026-11-22
area: runtime
---

## What and Why

Slot and element ids are positional. `allocSlotId` and `allocElementId` (`packages/stator/src/server/render-context.ts:226-235`) hand out `s0`, `s1`, `e0`, … from a per-scope counter, and only `each`, keyed rows, `when`/`match` arms and `defer` push a scope (`src/template/conditional.ts:54`). A plain conditional (`{x ? <a/> : <b/>}`, `{x && <i/>}`) and a component chosen by a value do not, so every id after one depends on which way it went.

A patch is addressed by id and applied blindly. So whenever the server computes patches from a render in which such a conditional went one way, for a browser holding HTML in which it went the other, values land on the wrong elements, and the patches for ids the page does not have are skipped with a console warning (or, in one direction, with no warning at all).

Confirmed on 2026-11-22, at server level, through the real applier under happy-dom, and in Chromium 155 (uncommitted, in `.claude/worktrees/agent-a4eac046b30ad0bf7`: `tests/repro-session-shift.test.ts`, 16 of 16 passing and pinning the bug; `browser-tests/session-shift.mjs`; fixtures under `tests/fixtures/session-shift/`). With a fixture whose total is 7 and whose member count is 42:

| How the page and the render came apart | What the visitor sees |
| --- | --- |
| Sign-in in another tab: `rotateSession()` hangs up the open tab's stream (`server/session.ts:191`), and its reconnect is synced under the new session (`server/http.ts:570-574`, `620-623`) | "Sign in" beside `Total: 42`, then `Total: 142` after the next update (truth: 8) |
| Claims set without rotation: fan-out is right (the connection keeps its connect-time render), but the tab's own `/__events` response is diffed against a baseline re-rendered under the new claims (`http.ts:793-806`). No live page needed | `Total: 242` (truth: 9) |
| Sign-out in another tab | The member line and user id stay, with anonymous values landing in them. No warning |
| Back after sign-in: a real back/forward-cache restore (`pageshow` with `persisted`, `client/runtime.ts:247-248`), and the HTTP-cache re-show when bfcache is off | As the first row |
| A shared cache serving anonymous HTML to a signed-in visitor ([[a-claims-read-always-withdraws-derived-caching]]) | As the first row |

It stays wrong until the visitor reloads. It is not specific to claims: any plain conditional on a value that differs between the page GET and a later render has this shape, including a frontmatter snapshot of machine state (`examples/live-poll/routes/p/[id].stator:14`, read but not run).

What is already safe: `when()`/`match()` arms are id-scoped and never misland, and `when(read(machine, …))`, which is how `examples/with-auth` writes every identity branch, converges fully in all four scenarios because a branch binding re-emits its HTML on every initial sync. No cross-user exposure was found; the misplaced values come from renders the current session is entitled to.

The only handshake between a page and the server today is the build id (`http.ts:564-568`). Nothing compares layouts. This spec adds that comparison.

## Success Criteria

- A page whose root-scope layout differs from the render the server is about to patch from is told to reload, on `/__sse` connect and on `/__events`, on live and non-live pages alike. After the reload it is correct.
- All four scenarios in the reproduction end, after one reload, in a DOM identical to a fresh load. No patch is applied to a mismatched page.
- A page whose layout matches sees no change in behaviour and no extra request.
- The reload cannot loop: it goes through the guard in [[a-build-mismatch-reload-is-guarded-against-a-stale-cache]].
- `when(read(machine, …))` pages keep converging by patch, with no reload.
- `stator check` warns on the template shape that causes this, so authors move to `when()` before the reload is ever needed.

## Constraints

- Patch release. The wire additions are optional: an older page that sends no fingerprint is treated as it is today.
- No change to emitted ids. Arm-scoping plain conditionals in the compiler would turn wrong patches into skipped ones without making the page converge, and it would change every id in every app.
- The fingerprint covers what cannot legitimately change by patch. An arm's interior and a list's rows change with machine state by design and are rebuilt by their own patches; they are not in it.
- Cheap enough for the `/__events` path, which renders a baseline on every event.

## Approach

### What is fingerprinted

After a route render, `renderState.bindings` (`server/render-context.ts`, `RenderState`) holds every binding by slot id. The fingerprint is a hash over the **root-scope** bindings, in id order:

```ts
// server/layout-fingerprint.ts (new)
export function layoutFingerprint(state: RenderState): string
```

For each binding whose slot id has no scope prefix (no `:`): its slot id, kind (`text`, `attr`, `list`, `keyed-list`, `branch`), machine name, and for an attribute binding its element id and attribute name. For `text` and `attr` bindings the selector's source text (`String(selector)`) is included too, so two arms that each hold one read of the same machine (`claims ? read(b, (b) => b.members) : read(b, (b) => b.total)`) do not collide. The hash is FNV-1a over the joined string, rendered as 8 hex characters. It is a consistency check between two renders by the same server code, not a security boundary.

A page with no root-scope bindings has no fingerprint and nothing to check.

### The page carries it

`renderGetCandidate` (`server/http.ts`, where `stator-live` and `stator-build` are pushed into `headHtml`) adds, for any page with a fingerprint, live or not:

```html
<meta name="stator-layout" content="9f3a01c2">
```

It is part of the HTML, so a cached or bfcached copy carries the fingerprint of the layout it actually has.

### The client echoes it

- `/__sse`: `client/runtime.ts` adds `&layout=<fp>` to the connect URL beside `&build=`, read once from the meta. It rides native reconnects and the `pageshow` reconnect, as the build id does.
- `/__events`: `client/transport.ts` sends `X-Stator-Layout: <fp>` beside `X-Stator-Route`.

### The server compares before it patches

**`/__sse`** (`http.ts`, after the build check and the route render at `570-574`): compute the fingerprint of the render just made for this session. If the page sent one and it differs, write one frame and end the stream, exactly as the build handshake does:

```json
{ "directives": [{ "type": "reload", "reason": "layout", "layout": "51c0e7aa" }] }
```

No initial sync is sent and the connection is not registered.

**`/__events`** (`http.ts:793-806`): the baseline render already exists. If the page's fingerprint differs from the baseline's, the event is still processed and persisted as usual, and the response carries no patches and the same `reload` directive. Processing first means the click takes effect and the reloaded page shows its result; refusing it would make the visitor click twice for a mismatch they did not cause. The guards have already decided whether this session may commit the event, as they do for any event. The replay cache stores this response like any other.

**Fan-out** needs no check: a connection diffs against its own connect-time render, which is the layout its page was synced to.

### The reload is guarded

The `reload` directive's `reason` becomes `'build' | 'layout'`, and the guard from the build-reload spec is keyed on reason plus token (the server's build id, or the server's expected fingerprint). A layout reload therefore happens at once the first time, and if the page that comes back still mismatches the same expected fingerprint (a hand-set cache header serving one visitor's HTML to another, for instance), it waits 5 s, 15 s, 30 s, 60 s between attempts and shows `data-stator-connection="stale"`. `reloadForBuild` in `client/build-reload.ts` is renamed `guardedReload(reason, token, hold)`.

### What it costs

One pass over root-scope bindings and one short hash per page render and per event baseline. `String(selector)` is a slice of source text the engine already holds. Measure on `weather`'s index (the densest page in the repo) before merging; if it shows, drop the selector text from the `/__events` path only and keep it on page GET and `/__sse`.

### What it does not catch

- **A plain conditional inside a `when` arm or a list row**, on a value that changed without a patch. Arm and row interiors are outside the fingerprint. On `/__sse` they are rebuilt wholesale by the initial sync, so the gap is the `/__events` response of a non-live page. The check warning below covers the authoring side.
- **Two layouts that are byte-identical in ids, kinds, machines and selector text** but sit in different markup. Nothing distinguishes them short of hashing the HTML.
- **Content that is not a binding.** Text rendered from claims stays as it was rendered until a reload; with `when(claims, …)` the arm does not flip. Those were never patched and are not mis-patched; they are stale. A page that must follow a session change uses `when(read(machine, …))`.

### The `stator check` warning

A second, smaller piece: a compile warning on the shape that makes the reload necessary. In a route or component template, a conditional expression or `&&` whose test reads a frontmatter binding initialised from `Stator.request.claims()` or from a property of a machine handle outside `read()`, when an arm contains a machine binding or a machine binding follows it in the same scope:

```
routes/p/[id].stator:14:7 warning: this branch is chosen once, when the page renders. If `found`
changes later, live updates after it can land on the wrong elements until the page reloads. Use
when(read(polls, (p) => p.has(id)), …) so the branch is part of the page's live state.
```

It lives in `compileWarnings` (it depends on no release-specific API, so the editor's bundled compiler can show it too) and never fails the check. It is heuristic: a test computed through a helper function is not followed.

### Docs

- `guides/realtime-sse.md`: beside "Reconnect to a new build = reload", a second exception: a page whose layout no longer matches reloads, and why a branch on session or machine state belongs in `when(read(…))`.
- `concepts/` reactivity page, where `when` is introduced: plain conditionals are render-time; `when(read())` is live.
- `WIRE.md`: the `layout` query parameter, the `X-Stator-Layout` header, the directive's `reason` and `layout`.
- `src/wire/apply.ts:34-39`: the comment that says a skipped patch is safe because ids are arm- or key-scoped is corrected to say which scopes that holds for.

### Changeset (patch)

"A page whose layout no longer matches what the server renders for it reloads instead of taking patches. Signing in or out in another tab, or going Back to a page after signing in, could leave a tab with one session's page receiving another's updates; where the template chose markup with a plain `{x ? … : …}` on claims or machine state, values landed on the wrong elements until the page was reloaded. Each page now carries a fingerprint of its binding layout, the server compares it on `/__sse` and `/__events`, and a mismatch reloads the page once. `stator check` warns on the template shape that causes it; `when(read(machine, …))` branches were never affected."

## Alternatives Considered

- **Reload when the session changes under the tab** (echo a session epoch). About half the size. It covers rotation, so sign-in, sign-out and Back, but not claims set without rotation, not a shared cache, and not a frontmatter machine snapshot that moved.
- **Arm-scoped ids for plain conditionals and components, in the compiler.** Wrong patches become skipped patches. The page still does not converge, hand-written `html` ternaries in `.ts` routes are untouched, and every emitted id in every app changes.
- **`Cache-Control: no-store` on session-dependent pages.** Affects only the Back case and costs the back/forward cache everywhere.
- **Resync in place: send the new layout's HTML as one patch.** There is no patch that replaces a root scope, and the document's head, scripts and island instances belong to the old layout. A reload is that patch.
- **Refuse the event on a mismatched `/__events`** and make the visitor repeat it. Rejected under Approach.
- **Fold the build-id handshake into the fingerprint**, reloading on deploy only when a page's layout changed. Tempting, and wrong today: a deploy also changes island bundles, styles and selector bodies that the fingerprint does not see. Left as a possible later refinement.

## Open Questions

- **Process the event before reloading, or not?** Recommended: process. The case against is a tab that is visibly out of date sending an event the visitor would not have sent had they seen the current page; guards are the answer to that in every other case too.
- **Selector source in the hash.** It closes the same-shape collision and costs a string per binding per render. Recommended: include it, measure, and drop it from the event path only if it shows.
- **Should the dev server say why it reloaded?** A one-line dev log naming the route and the first differing binding would turn a surprising reload into a pointer at the template line. Cheap; worth doing in the same PR if the fingerprint function can return the difference.
- **`clearClaims()` without rotation** leaves a connection pushing member-arm values to a signed-out tab. That is authorisation staleness, covered by "rotate on any privilege change", and out of scope here. Worth a sentence in the middleware guide.

## Implementation Notes

Two PRs. The first depends on the build-reload guard and lands with or straight after it; both precede the 3.1 work in `server/http.ts`, `client/runtime.ts` and `client/transport.ts`.

**PR 1 — the fingerprint and the reload (M).**

- `packages/stator/src/server/layout-fingerprint.ts` (new).
- `server/http.ts`: the meta in `renderGetCandidate`; the comparison in the `/__sse` handler; the comparison in the `/__events` handler; `X-Stator-Layout` read beside `X-Stator-Route`.
- `wire/index.ts` and `WIRE.md`: `reason: 'build' | 'layout'`, `layout?: string`.
- `client/runtime.ts`: `&layout=` on the connect URL. `client/transport.ts`: the header. `client/build-reload.ts`: `guardedReload`.
- `wire/apply.ts`: the corrected comment; the `reload` case passes `reason` and token through.
- Tests: promote the reproduction (`tests/repro-session-shift.test.ts` and `tests/fixtures/session-shift/`) with its assertions inverted: in scenarios A, B, C and D the tab receives one `reload` directive with `reason: 'layout'` and no patches; `/machine-when` still converges by patch with no reload; `/when-branch` gets no reload (its root layout is stable). Unit tests for `layoutFingerprint`: stable across two renders of the same state, different across a plain-conditional flip, equal across a `when` arm flip, different for same-shape arms with different selectors, absent with no root bindings. `tests/build-reload-guard.test.ts`: a layout reload that keeps mismatching backs off. `browser-tests/session-shift.mjs` kept as the real-browser check for the two-tab and bfcache cases (it needs a Playwright not in the repo's dependencies; decide whether to add it or leave the script manual).
- Docs and changeset as above.

**PR 2 — the check warning (S to M).** `compiler/` (`compileWarnings` and the frontmatter analysis that already tracks `Stator.*` bindings), `tests/compile-warnings` cases for claims, a machine snapshot, a helper-wrapped test (no warning), and a branch with no bindings in or after it (no warning). Rewrite `examples/live-poll/routes/p/[id].stator:14` to `when(read(…))` if the warning fires on it.
