---
title: 'A build-mismatch reload is guarded against a stale cache'
status: ready
created: 2026-11-22
updated: 2026-11-22
area: client
---

## What and Why

A live page carries the build it was rendered against (`<meta name="stator-build">`) and echoes it when it opens `/__sse`. When the server is running a different build it answers with one frame, `{"directives":[{"type":"reload"}]}`, and ends the stream (`packages/stator/src/server/http.ts:564-568`). The client runs it as a bare `location.reload()` (`src/wire/apply.ts:121-123`). There is no guard of any kind.

A live page that reads only app machines is cacheable at the edge, build id included: it goes out as `public, max-age=0, s-maxage=60, stale-while-revalidate=300`. `stator build` mints a new id every time (`randomUUID()`, `src/build/build.ts:291,300`). So after a deploy, a cache that still holds the old HTML gives the reloading tab the old build id again, the tab connects, is told to reload, and loops for as long as the cache keeps answering.

Reproduced on 2026-11-22 (uncommitted, in the worktree `.claude/worktrees/agent-a2b1f92db79560741`):

- happy-dom, real `initLiveChannel`, a stub cache that always returns the stored HTML: 25 reloads out of 25 loads, stopping only at the test's cap (`tests/repro-stale-build-reload-loop.test.ts`).
- Real Chromium behind a proxy that ignores request directives: 217 page loads and 216 `/__sse` connects in 5 seconds (`browser-tests/repro-stale-reload.mjs`). Behind a proxy that honours the reload's `Cache-Control: max-age=0`: 2 loads, then a normal sync.

Checked against production on 2026-11-22: tonysull.co's Cloudflare zone answers `HIT` for the live home page on requests carrying `Cache-Control: max-age=0`, and on ones carrying `Cache-Control: no-cache` with `Pragma: no-cache`. The cache does not honour a reload, so the looping case is the real one. Every public page on that site is a live route. It has not been noticed because it needs the page cached at the visitor's edge location within the `s-maxage` before a deploy and a tab loading or reconnecting inside that window; at low traffic the edge entry is usually cold. A busier site would hit it on every deploy.

Each cycle costs the fresh origin one `/__sse` request and the visitor a page that reloads many times a second and discards anything typed.

## Success Criteria

- A tab told to reload for a build mismatch reloads at once the first time, as now.
- If the page that comes back still mismatches, the tab does not reload again immediately. It waits with a growing delay, reloads again, and recovers by itself once the cache serves the new build.
- While it waits, the page does not hold or retry a live connection, and it reports its state through the existing connection signal.
- The reproduction's always-stale cache produces a bounded number of reloads: no more than 5 in the first two minutes.
- Dev reloads (`stator dev` rebuilds) and app-sent `reload` directives behave exactly as before.
- Works when `sessionStorage` is unavailable.

## Constraints

- Patch release. The wire change is additive: an older client that sees the new fields ignores them and reloads as it does today.
- Live pages stay cacheable. Not deriving `Cache-Control` for live routes would end the loop and would also take every page of a site like tonysull.co out of the edge cache.
- No cache-busting URL. It assumes the cache keys on the query string, and the route key is built from `location.pathname + location.search`.

## Approach

### The server says why

```ts
// wire/index.ts
| { type: 'reload'; reason?: 'build'; build?: string }
```

The handshake in `server/http.ts` sends `{ type: 'reload', reason: 'build', build: config.buildId }`. Every other `reload` (the dev broadcast in `server/dev-native.ts`, a directive an app returns) carries no `reason` and is not guarded: those are requests to reload, where this one is a remedy that can fail to take.

### The client remembers that it tried

In `wire/apply.ts`, the `reload` case hands a build-reason directive to a small function (new, `client/build-reload.ts`, so the page runtime and tests share it):

```ts
// sessionStorage key 'stator:build-reload'
interface Attempt { path: string; build: string; count: number; at: number }

const DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000] // then 60s each time

export function reloadForBuild(serverBuild: string, hold: (delayMs: number) => void): void {
  const prev = readAttempt()                                   // null on any storage error
  const same = prev && prev.path === location.pathname && prev.build === serverBuild
  const count = same ? prev.count : fallbackCount()            // see below
  const delay = DELAYS_MS[Math.min(count, DELAYS_MS.length - 1)]!
  writeAttempt({ path: location.pathname, build: serverBuild, count: count + 1, at: Date.now() })
  if (delay === 0) location.reload()
  else hold(delay)                                             // the runtime waits, then reloads
}
```

- First mismatch for this path and server build: reload at once. Nothing changes for the ordinary deploy.
- The reloaded page mismatches again (the stored record names the same path and server build): the cache gave back the old HTML. Wait 5 s, reload; then 15 s, 30 s, 60 s, and 60 s thereafter. With the default `s-maxage=60` the second or third attempt lands on the new build.
- A different server build (another deploy) starts the sequence again. A record older than 10 minutes is ignored.
- A successful connection clears the record: the runtime removes the key when a live channel opens and receives its first frame.

**Without `sessionStorage`** (blocked, or a private mode that throws): `fallbackCount()` returns 1 when this document was itself loaded by a reload (`performance.getEntriesByType('navigation')[0]?.type === 'reload'`) and 0 otherwise. So the page still reloads once at once and then waits 5 s between attempts, without growing the delay. A manual reload followed by a mismatch waits 5 s once, which is harmless.

### While it waits

`hold(delayMs)` in `client/runtime.ts`:

- closes the `EventSource`, which also stops its native reconnect (otherwise it would reconnect every few seconds and be told to reload each time);
- sets the connection state to `stale` through the existing `setConnectionState` (`data-stator-connection="stale"` and the `stator:connection-state` event), which apps already hang an "out of date" banner on;
- sets one timer that calls `location.reload()`. The idle-release and visibility logic must not reopen the channel while the hold is in place.

The page stays usable as static HTML during the hold. Events still post: `/__events` has no build check. That is today's behaviour for any page between a deploy and its reload, and it is left alone here.

### What is not changed

- `deriveCacheControl` (`server/http.ts`): live pages keep their derived header.
- The build id stays a `randomUUID()` per build. Deriving it from build content would stop a no-op redeploy from reloading anyone; it is a separate, smaller change (Open Questions).
- `stator dev`: no `caching` config is passed (`server/dev-native.ts:465-485`), so the reloaded HTML always carries the new id and there is no loop to guard.

### Docs

- `guides/realtime-sse.md`, "Reconnect to a new build = reload": add that behind a cache still holding the old page the tab waits and retries instead of looping, and shows `data-stator-connection="stale"` while it does.
- `guides/production.md`: purging the CDN on deploy makes the cutover immediate; without a purge, open tabs catch up within the cache's `s-maxage`.

### Changeset (patch)

"A live page told to reload for a new build no longer loops when a CDN is still serving the old page. It reloads once; if the page that comes back is still the old build it waits (5 s, then longer) before trying again, and shows `data-stator-connection=\"stale\"` meanwhile. Before, a cache that ignored the reload's revalidation header kept the tab reloading many times a second until its entry expired."

## Alternatives Considered

- **Do not derive `Cache-Control` for live routes.** One line, and complete for derived headers. It gives up edge caching for every live page, which is most of a content site that shows live counts, and a hand-set header on a live page could still loop.
- **A cache-busting navigation** (`location.replace` with a throwaway query parameter, stripped afterwards). Depends on the cache keying on the query string, changes the route key the page computes from `location.search`, and leaves a visible URL flicker.
- **Resync instead of reloading.** The handshake exists because the old page's slot ids may not match the new build's render. Resyncing onto them is the bug class in [[a-claims-read-always-withdraws-derived-caching]].
- **Have the server stop sending the directive after N times.** The server would need per-tab state for a problem the tab can see for itself.

## Open Questions

- **Is `stale` the right state to show, or should a build hold have its own?** `stale` exists and means "this page may be behind"; a new value would be a fifth state on a public attribute. Recommended: reuse `stale`.
- **Should the server send a hint for the delay?** It knows `caching.sMaxAge` and could send `retryAfterMs`, so the second attempt lands just after the edge entry expires. It does not know a hand-set header's lifetime or the CDN's stale-serving behaviour. Recommended: fixed delays first; add the hint if the fixed sequence proves badly matched.
- **A content-derived build id.** Hashing the build's outputs in place of `randomUUID()` would mean a redeploy with no changes reloads nobody. Separate change; it reduces how often this path runs at all.
- **Events from a page in a hold.** They post against the new build with the old page's markup. Patches in the response can target ids the old DOM lacks (skipped with a warning) or, for a plain conditional, the wrong element. Same class as the open question in the claims spec; out of scope here.

## Implementation Notes

One PR, S to M.

- `packages/stator/src/wire/index.ts`: the `reload` directive's optional `reason` and `build`. `WIRE.md`: the same, with the sentence that a client ignores fields it does not know.
- `packages/stator/src/server/http.ts`: the handshake frame.
- `packages/stator/src/client/build-reload.ts` (new): `reloadForBuild`, the storage read/write with `try`/`catch`, `fallbackCount`, `clearBuildReload`.
- `packages/stator/src/wire/apply.ts`: the `reload` case branches on `reason === 'build'`. `applyDirectives` needs the `hold` callback from its caller; the page runtime passes it, other callers get an immediate reload.
- `packages/stator/src/client/runtime.ts`: `hold`, clearing the record on the first frame of a healthy channel, and keeping the release/visibility paths from reconnecting during a hold.
- Tests: promote `tests/repro-stale-build-reload-loop.test.ts` from the worktree as `tests/build-reload-guard.test.ts` with `mock.timers`: the always-stale cache yields reloads at 0, 5, 20, 50 and 110 seconds and no others; the control (cache goes to origin on reload) yields one reload and a normal sync; a dev-style `reload` with no `reason` reloads at once every time; storage that throws falls back to the navigation type. Extend `tests/build-id-reload.test.ts` for the new frame shape. The Chromium script (`browser-tests/repro-stale-reload.mjs`) is worth keeping as a real-browser check that the count is small. The reproduction test's process lingered about 80 seconds after finishing; find the open handle when promoting it.
- Docs and changeset as above.
- Touches `server/http.ts` and `client/runtime.ts`, which the 3.1 work also edits (the `/__events` handler and the POST-response path, respectively); land this first.
