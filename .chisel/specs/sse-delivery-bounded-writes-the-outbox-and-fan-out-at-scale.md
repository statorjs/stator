---
title: 'SSE delivery: bounded writes, the outbox, and fan-out at scale'
status: in-progress
created: 2026-09-04
updated: 2026-09-04
area: runtime
---

## What and Why

A dogfood report on `2.10.0-next.0`: a list-heavy, SSE-live app showed a table holding rows that no longer existed after the machine running it went idle and later reconnected. The reported hypothesis was that the reconnect's patch set was incomplete — that nothing told the client to delete rows the server had dropped — and that keyed `each` needed a "these are all the items" reconciliation on reconnect.

That hypothesis was wrong, and the way it was wrong is the useful part. The reconnect reconciliation already exists and is correct. The defect was one layer down, in liveness rather than in the diff, and chasing the reported symptom to its actual mechanism turned a list bug into a redesign of the delivery pipeline.

This spec records that chain, the fix that shipped, and the design that follows from it.

## What was already correct

`initialSyncPatches` (`server/recompute.ts:318`) does exactly what the report asked for. On every connect it re-renders each keyed list's rows from current truth, unregisters the old per-row bindings, and emits **one wholesale `html` reset** for the list, then invalidates every text/attr/branch baseline so the normal recompute paths re-emit at current values. `replaceRegion` (`wire/region-apply.ts:96`) clears everything between the region's comment markers before inserting.

Verified against a real connection: three rows added, the connection aborted, two rows removed while disconnected, then a fresh connect.

```
data: {"patches":[{"target":{"kind":"slot","id":"s0"},"op":"html",
       "value":"<li>row1</li><li>row2</li><li>row3</li>"}]}
```

A reconnect reconciles the whole list. No new primitive is needed for that.

## The actual defect

The same reproduction never reached its second connect. The **dispatch that followed the disconnect never returned**.

Two facts combine:

- `sse.ts` awaited `conn.send(...)` per connection, serially, with only a `try/catch` around it. No deadline.
- `http.ts:550` awaits `fanOut(...)` **inside** `withSessionLock` (`http.ts:511`).

A write to a live socket resolves. A write to a closed socket rejects. A write to a **half-open** socket does neither — when a machine sleeps or a NAT mapping is dropped, no FIN arrives, the socket still looks writable, and the promise simply never settles. So one sleeping tab held the session lock forever, and every later request for that session queued behind it — including the reconnect whose initial sync would have repaired the page.

That is the whole reported symptom: a frozen list showing rows that no longer exist, which reconnecting cannot fix, because the reconnect itself is blocked. Predates 2.10 entirely; this path is unchanged since 2.9.x.

Worth recording why it presents as a hang rather than a leak: raw Node's `res.write()` never blocks — it buffers and returns `false`, and the caller is expected to wait for `drain`. A promise-based writer that resolves on drain converts unbounded memory into an unbounded wait, and awaiting it under a lock converts one client's problem into the session's.

## Shipped (2.10.0-next.2)

- Every push goes through one bounded path, `pushToConnection`, with a deadline (`STATOR_SSE_WRITE_TIMEOUT_MS`, default 5000). A timed-out connection is dropped rather than retried: the client reconnects and resyncs, which is cheap by design.
- Fan-out sends **concurrently** across connections instead of serially. Recompute stays sequential because it advances each connection's diff baselines; sends still all complete before the dispatch returns, because fan-out holds the session lock and the next dispatch must not interleave — keyed `insert`/`remove`/`move` are positional, and out-of-order delivery corrupts a list rather than merely staling it.
- The heartbeat uses the same bounded path, so a wedged connection is reaped within a ping interval even when the app is idle and no dispatch would otherwise notice.
- The dev rebuild broadcast, which had the identical unbounded serial await, is bounded the same way.

That removes the freeze. It does not remove the coupling, and the rest of this spec is about that.

## Why deadline-and-drop is not the end state

Raised in review: killing a connection on a stall punishes exactly the users who can least afford it. A mobile stall of 5–30 seconds — a tunnel, a cell handoff, TCP backing off — is routine and **recoverable**. Dropping at 5s converts a recoverable stall into a reconnect, and a reconnect costs a full resync: every keyed list re-rendered wholesale plus every binding at current value. With no `retry:` field ever sent, reconnects use the browser's fixed ~3s with no backoff or jitter, so several stalled tabs retry in lockstep.

The inversion is the problem: **we make the payload biggest exactly when the network is worst.**

A second, independent problem surfaced in the same review. Because `await fanOut(...)` precedes the response envelope, the acting user's POST waits for recompute *and* a socket write to every other observer. Dispatch latency scales with the number of live viewers, and it is paid by the wrong person. Bounded at 5s by the fix above; previously unbounded.

## Design: the outbox

Per-connection outbox, drained by a per-connection writer. Fan-out computes and enqueues; nothing awaits a socket inside a request or under a lock.

**It coalesces rather than queues.** From the patch union (`wire/index.ts:32`), `text`/`html`/`attr` are last-write-wins per target — ten updates to one slot are worth the tenth. Only `insert`/`remove`/`move` are positional, and a run of those for one list collapses into a single `html` reset of that list, which is the same per-list re-render `initialSyncPatches` already produces. So a connection holds **at most one pending write per slot**:

- Queue size is bounded by the page's binding count, not by event volume. There is no capacity number to choose.
- The recovery payload is proportional to *what changed*, not to the whole page — the death-spiral inversion disappears.
- Focus and scroll survive everywhere except lists that actually changed. (Today's reconnect resync replaces every keyed region, so inline editing inside a row is destroyed. That is a current cost of reconnect, not one the outbox introduces.)

### Decisions taken

**Directives are kept, coalesced by semantics.** Directives (`wire/index.ts:44`) are commands, not state, so they cannot last-write-wins as a class. But dropping them wholesale is wrong: a forced redirect on auth invalidation must be honoured when the network returns, or a tab sits on a page it should have been kicked off. They age differently, so they collapse differently:

| directive | on collapse |
| --- | --- |
| `reload` | keep — terminal and idempotent, and it supersedes everything queued before it |
| `navigate` | keep the last only; supersedes earlier history ops |
| `push-url` / `replace-url` | keep the last; drop if a navigate or reload follows |
| `focus` | **drop** — moment-bound; delivering it after a long stall steals focus from wherever the user actually is |

**Collapsing a list must prune its descendant slots.** Keyed row bindings are scoped under the list: `keyedScopePrefix` (`render-context.ts:242`) yields `<listSlot>:k<keyToken>`. The server already destroys those registrations on a wholesale re-render — `recompute.ts:328` calls `unregisterBindingsForScope` per key. The outbox must mirror it: a queued `{target: s0:kr3:s1, op:'text'}` delivered *after* a reset of `s0` writes into whatever that id names in the re-rendered row, and if the row's internal structure changed (a `when` inside it flipped arms) that is a different binding than the patch was computed for. A silent wrong-slot write. The rule is mechanical — dropping every queued patch prefixed by the collapsed list's scope — and the test is a stalled connection with a queued row-field patch plus a list churn, asserting the row patch never ships.

**Recompute stays inside the session lock; only writes move out.** Keeping the compute in the lock avoids two hazards for free: concurrent jobs mutating one connection's diff baselines, and rehydrating from the store while another dispatch is mid-persist (a torn read across machines). Enqueueing is synchronous, so the lock is never held across a socket write.

**The originator's response and its own outbox must stay ordered.** The acting user's patches ride the POST response while queued items ride the SSE — two channels to one connection. If that connection's queue is non-empty, its patches must be enqueued rather than returned in the response, or a positional list op can apply out of order. Fast path unchanged when the queue is empty, which is the normal case.

### Sequencing

1. **Instrumentation + split the two timeouts.** The latency budget (how long a dispatch waits on a push) and the give-up policy (how long before a connection is abandoned) are currently one number and should not be. On a stall: mark `needsResync` rather than drop, so the connection survives to be observed and the client cannot silently diverge — its baselines were already advanced by the recompute whose patch never landed.
2. **Per-connection write queue.** Fan-out computes in-lock, enqueues, returns. **This is where the POST stops blocking.** Overflow initially reuses the resync flag from step 1.
3. **Coalescing per slot, directive semantics, and the give-up threshold chosen from the data.**

## Instrumentation, and why not telemetry

The give-up threshold is a question about the world, not about taste: do stalls of N seconds recover? Deciding it from anecdote is how you get a number nobody can defend.

A phone-home was considered and rejected. The data is **operational, not product analytics** — write durations and stall recovery belong in the operator's own observability, correlated with their network. Opt-in reporting also has a fatal selection problem for this specific question: the users who matter are on flaky mobile networks in apps someone shipped and forgot, and they are the least likely to be running a build where a maintainer opted in. Set against that, the trust cost of framework telemetry is real and asymmetric for a young project. The same principle already applied to auth holds here: enable the toolkit, don't become one.

So the framework emits and the operator collects. Aggregate in process and emit **one summary line per window, only when the window contained a stall or a drop** — a healthy app logs nothing:

```
stator: sse writes — 1284 pushes (p50 6ms, p99 210ms) · 4 stalls >1s:
        3 recovered (2.1s, 4.8s, 19.3s), 1 dropped after 60s
```

Per-push records stay at `debug`. The in-memory aggregate is what a `/@stator/metrics` endpoint or the reserved `observers` seam (`config.ts`) would later expose; the summary line is the interim, and it needs no collection infrastructure to be useful.

Note the sequencing constraint: recovery data only exists once connections are held open, so step 1 must land before the numbers mean anything.

## Scale, and the limits of the runtime

Queueing moves work off the response path; it does not make the work smaller. Per dispatch, fan-out is **O(N observers)** of CPU and allocation on one thread: rehydrate, recompute the connection's bindings, `JSON.stringify`, write.

One asymmetry helps. Session machines fan out only to the touching session's own connections and rehydrate from the store — expensive per connection, but N is "that user's tabs". App machines reach every connection and **skip rehydration entirely** (the shared instance is the state). So the large-N broadcast case is CPU-bound, not Redis-bound.

Order of magnitude: 1000 viewers × ~50 bindings at ~1µs per evaluation is ~50ms of event loop per dispatch. Ten dispatches a second is half the loop; a hundred saturates it, and unrelated requests queue behind.

**Levers available without an architecture change:**

- **Compute once per group.** Connections on the same route with the same params and the same baseline produce byte-identical patches, which in the broadcast case is nearly all of them. Grouping by (routeKey, baseline generation) turns O(N × bindings) into O(groups × bindings) + O(N) writes. Phoenix does not do this — each LiveView process re-renders independently and they buy their way out with cores — so being single-threaded pushes us toward the better algorithm.
- **Coalesce fan-out jobs, not just patches.** Ten dispatches landing before the worker runs need one pass, since recompute diffs baseline→current. Cost decouples from write rate.
- **Yield to the loop every K connections**, or one large pass stalls every unrelated request. The cooperative-scheduling tax for not being on the BEAM.

**On using more cores.** Node can, and Stator already does where it fits: `sharp` (indie-blog `lib/media.ts:54`) runs in libvips' own native thread pool, off the event loop, with no `worker_threads`. Fan-out is a different shape: the unit of work is a **closure over live objects** — `itemRenderer`, `keyFn`, and each binding's read function are functions, and structured clone throws `DataCloneError` on a function — so it cannot cross a thread boundary without redesigning templates into serialisable data and re-instantiating them per worker. Per-item work is microseconds against a ~50–100µs postMessage round trip, and baselines must advance exactly once, in order.

The way Node scales a server across cores is `cluster`, and for Stator that is precisely the multi-replica problem: SSE fan-out and app machines are in-process, so two workers means two app-machine instances with connections split between them. **"Use more cores" and "run more replicas" are therefore the same problem**, answered by the deferred 1.x Redis backplane — not by a worker pool. Which is the argument for grouping: it is the lever available before that change.

One multi-core lever we do not use: Node's async `zlib` runs on the libuv threadpool, so compressing SSE payloads would be genuinely parallel work off the event loop — and it applies hardest to a resync, the largest thing we ever send, to the client least able to receive it.

**Memory.** The dominant term is not the outbox but the per-connection `RenderState`: every binding, its `lastValue`, and for keyed lists a `rowsByKey` of per-row binding arrays. A 500-row table across 1000 connections is the figure that will hurt, and it is true today independent of any of this. A coalesced outbox adds at most one pending entry per slot on top.

## Open

- The give-up threshold — blocked on step 1's measurements, deliberately.
- Whether grouping is worth building, and for what N. Measure before deciding: connections considered per pass, groups that would have formed, patch bytes, pass duration.
- Whether SSE payloads should be compressed, and whether that changes the resync calculus for slow clients.
- `pushToConnection` currently arms a `setTimeout` per push and clears it microseconds later on a healthy write. At N connections × dispatch rate that is pointless timer churn; it should arm only if the write has not settled after a tick, or use one coarse sweep.