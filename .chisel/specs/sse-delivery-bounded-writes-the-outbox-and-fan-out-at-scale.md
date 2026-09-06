---
title: 'SSE delivery: bounded writes, the outbox, and fan-out at scale'
status: in-progress
created: 2026-09-04
updated: 2026-09-06
area: runtime
---

## What and Why

A dogfood report on `2.10.0-next.0`: a list-heavy, SSE-live app showed a table holding rows that no longer existed after the laptop running it slept and woke. The reported hypothesis was that the reconnect's patch set was incomplete, that nothing told the client to delete rows the server had dropped, and that keyed `each` needed a "these are all the items" reconciliation on reconnect.

That hypothesis was wrong. The reconnect reconciliation already exists and is correct. Chasing it found a real defect in the delivery pipeline, and this spec records that defect, the fix that shipped, and the design that follows from it. But the defect is not what the report saw, and it is worth being precise about why.

The reporting app ran its server locally, on the same machine that slept. A loopback socket survives sleep, both processes suspend together, and no fan-out runs while the server is asleep. On wake the page either continues on a connection that is genuinely healthy, or the staleness watchdog rebuilds it into a full resync. Either way the DOM matches the server. The rows were stale because the **server's own state** was stale: whatever feeds the table (robot pushes lost while the machine was unreachable, an outbound subscription that went half-open on the ingest side, or a poll loop whose in-flight effect failed on wake and never re-armed) did not reconcile after the sleep. That is an ingestion concern for the app, and the check next time is to compare the machine's state in the inspector against the DOM. The delivery layer was not involved.

So nothing in this spec is evidenced by that incident. The defect below is real for a remotely deployed server, where a client's sleep does produce a half-open socket, and it was found by reading the path the report pointed at.

## What was already correct

`initialSyncPatches` (`server/recompute.ts:318`) does exactly what the report asked for. On every connect it re-renders each keyed list's rows from current truth, unregisters the old per-row bindings, and emits **one wholesale `html` reset** for the list, then invalidates every text/attr/branch baseline so the normal recompute paths re-emit at current values. `replaceRegion` (`wire/region-apply.ts:96`) clears everything between the region's comment markers before inserting. A reconnect reconciles the whole list, and `sse.test.ts` now pins it: three rows rendered, two removed while disconnected, and the connect-time sync is a single `html` op carrying only the survivor.

The client side holds up too. On wake a visible tab rebuilds its channel within ten seconds: the watchdog (`client/runtime.ts:180`) checks every ten seconds for a sixty-five-second silence, the visibility handler runs the same check on return, and a browser that notices the network change errors the `EventSource` into its own retry. Every one of those paths lands on a fresh `/__sse` and gets the sync above. No new primitive is needed for any of this.

## The actual defect

`sse.ts` awaited `conn.send(...)` per connection, **serially, in registry order**, with only a `try/catch` around it and no deadline.

A write to a live socket resolves. A write to a closed socket rejects. A write to a **half-open** socket does neither once its buffer is full: when a remote client sleeps or a NAT mapping is dropped, no FIN arrives, the socket still looks writable, and the promise simply never settles. On a mostly idle Linux socket the send buffer is tens of kilobytes, so a table pushing a few kilobytes per update fills it within tens of updates.

From that point one dead connection stalls the loop, and **every connection registered after it receives nothing** from any fan-out until the corpse dies. A corpse dies when the kernel gives up retransmitting, on the order of fifteen to thirty minutes, or when the same page-load reconnects and `registerConnection` evicts it (`sse.ts:47`). Two things make corpses common: a client-side close of a dead socket never reaches the server, so a released background tab is a corpse too, and a page reload mints a new client id, so it does not evict the old one.

Two things the first draft of this spec got wrong, recorded so they are not repeated:

- The session lock did not hold forever. It has a thirty-second backstop (`session-lock.ts:26`) that fails the mutation and drains the chain. A session behind a corpse degraded to one failing POST per thirty seconds, which is bad, but it is a different failure from a freeze and it is visible to the dispatching user as an error.
- The reconnect was never blocked. `/__sse` takes no lock (`session-lock.ts:12`), so a reconnecting page always got its initial sync. What it did not get, before the fix, was any fan-out after that, if a corpse sat ahead of it in the registry.

Worth recording why a half-open socket presents as a hang rather than a leak: raw Node's `res.write()` never blocks, it buffers and returns `false`, and the caller is expected to wait for `drain`. A promise-based writer that resolves on drain converts unbounded memory into an unbounded wait, and awaiting it inside a loop converts one client's problem into everyone else's.

## Shipped (2.10.0 prerelease)

- Every push goes through one bounded path, `pushToConnection`, with a deadline (`STATOR_SSE_WRITE_TIMEOUT_MS`, default 5000). A timed-out connection is dropped rather than retried: the client reconnects and resyncs, which is cheap by design.
- Fan-out sends **concurrently** across connections instead of serially. Recompute stays sequential because it advances each connection's diff baselines; sends still all complete before the dispatch returns, so the next dispatch cannot interleave with this one's writes, and keyed `insert`/`remove`/`move` are positional, where out-of-order delivery corrupts a list rather than merely staling it.
- The heartbeat uses the same bounded path, so a wedged connection is reaped within a ping interval even when the app is idle and no dispatch would otherwise notice.
- The dev rebuild broadcast, which had the identical unbounded serial await, is bounded the same way.

That removes the stall. It does not remove the coupling, and the rest of this spec is about that.

## Why deadline-and-drop is not the end state

Two arguments were made in review, and they carry different weight.

The stronger one: because `await fanOut(...)` precedes the response envelope, the acting user's POST waits for recompute *and* a socket write to every other observer. Dispatch latency scales with the number of live viewers, and it is paid by the wrong person. The fix bounds it at the write deadline. It was unbounded before.

The weaker one, narrowed from the first draft: that a five-second deadline punishes users on flaky networks, converting a recoverable mobile stall into a reconnect and a full resync, so that the payload is biggest exactly when the network is worst. The inversion is real but the trigger is narrower than "a stall of five seconds". A write to a socket with buffer space resolves immediately regardless of the peer, so the deadline fires only when the buffer has stayed full for the whole window. A mostly idle live page in a tunnel does not trip it. A client stalled mid-resync, with a large keyed table in flight, does. With no `retry:` field ever sent, reconnects use the browser's fixed few-second retry with no backoff or jitter, so several such clients retry in lockstep.

One more defect in the bounded-write shape, visible only under load: the deadline's clock started when a write was *issued*, not when it reached the socket. A burst of writes to one healthy but slow connection queued inside the stream writer, and the later ones could exceed the deadline while waiting their turn, dropping a connection that was draining fine. The write queue fixed this by construction: the clock now starts when the drain loop issues the write.

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

**The originator's response and its own outbox must stay ordered.** The acting user's patches ride the POST response while queued items ride the SSE — two channels to one connection. This window exists today in miniature: another session's fan-out can have a write to this page in flight while this page's own POST returns, and nothing orders the two sockets. A queue widens it from microseconds to queue depth, so the rule ships with the queue: if that connection's queue is non-empty, fan-out enqueues the originator's recomputed patches instead of skipping it, and the response carries none. Fast path unchanged when the queue is empty, which is the normal case.

### Sequencing

1. **Per-connection write queue.** Fan-out computes in-lock, enqueues, returns. **This is where the POST stops blocking.** Each queued item drains through the same bounded write, so the deadline measures time-to-drain one item at the head of the queue rather than time since it was issued. Overflow, a byte cap per connection, drops the connection: the same policy as a timeout today, so nothing new to tune. The originator rule ships with it. The heartbeat and the dev broadcast enqueue like everything else, and shutdown discards queues. **Shipped in the 2.10.0 prerelease** as its own PR, separate from the bounded-write fix, because it changes a timing contract (a dispatch no longer waits on any observer's socket) and a prerelease is where that belongs. `enqueue` and the drain loop live in `sse.ts`, `fanOut` returns `originatorQueued` and `/__events` empties the response's patches when it is set, and `STATOR_SSE_QUEUE_MAX_BYTES` is the cap. Tests cover a wedged connection delaying no one, FIFO order across back-to-back fan-outs, the cap, and the originator-with-backlog case end to end against a paused reader.
2. **Instrumentation summary line.** Split the latency budget from the give-up policy, and mark `needsResync` on a stall rather than dropping, once there is a remotely deployed app to measure.
3. **Coalescing per slot, directive semantics, and the give-up threshold chosen from the data.**

Step 1 needed no measurement to justify: a request must not wait on someone else's socket, and that is a structural property rather than a tuning question. Steps 2 and 3 wait for numbers, and the incident that opened this spec is not one of them.

## Instrumentation, and why not telemetry

The give-up threshold is a question about the world, not about taste: do stalls of N seconds recover? Deciding it from anecdote is how you get a number nobody can defend.

A phone-home was considered and rejected. The data is **operational, not product analytics** — write durations and stall recovery belong in the operator's own observability, correlated with their network. Opt-in reporting also has a fatal selection problem for this specific question: the users who matter are on flaky mobile networks in apps someone shipped and forgot, and they are the least likely to be running a build where a maintainer opted in. Set against that, the trust cost of framework telemetry is real and asymmetric for a young project. The same principle already applied to auth holds here: enable the toolkit, don't become one.

So the framework emits and the operator collects. Aggregate in process and emit **one summary line per window, only when the window contained a stall or a drop** — a healthy app logs nothing:

```
stator: sse writes — 1284 pushes (p50 6ms, p99 210ms) · 4 stalls >1s:
        3 recovered (2.1s, 4.8s, 19.3s), 1 dropped after 60s
```

Per-push records stay at `debug`. The in-memory aggregate is what a `/@stator/metrics` endpoint or the reserved `observers` seam (`config.ts`) would later expose; the summary line is the interim, and it needs no collection infrastructure to be useful.

Note the sequencing constraint: recovery data only exists once connections are held open, so step 2 must land before the numbers mean anything.

## Scale, and the limits of the runtime

Queueing moves work off the response path; it does not make the work smaller. Per dispatch, fan-out is **O(N observers)** of CPU and allocation on one thread: rehydrate, recompute the connection's bindings, `JSON.stringify`, write.

One asymmetry helps. Session machines fan out only to the touching session's own connections and rehydrate from the store — expensive per connection, but N is "that user's tabs". App machines reach every connection and **skip rehydration entirely** (the shared instance is the state). So the large-N broadcast case is CPU-bound, not Redis-bound.

Order of magnitude: 1000 viewers × ~50 bindings at ~1µs per evaluation is ~50ms of event loop per dispatch. Ten dispatches a second is half the loop; a hundred saturates it, and unrelated requests queue behind.

**Levers available without an architecture change, in the order they pay:**

- **Coalesce fan-out jobs, not just patches.** Ten dispatches landing before the worker runs need one pass, since recompute diffs baseline→current. Cost decouples from write rate, which is the lever that matters for a table fed by a burst of machine updates: the recompute rate becomes a function of the tick, not of the ingest. It also slows how fast a dead connection's buffer fills.
- **Compute once per group.** Connections on the same route with the same params and the same baseline produce byte-identical patches, which in the broadcast case is nearly all of them, and they stay in lockstep because every app-machine fan-out advances every baseline and a new connection starts current. Grouping by (routeKey, params, baseline generation) turns O(N × bindings) into O(groups × bindings) + O(N) writes. The real prize is one `RenderState` per group, which is also the memory term, and that is the larger change: today every connection carries its own bindings and `lastValue`s (`sse.ts:40`), and a route mixing session reads or session-keyed `when` arms cannot share. Phoenix does not do this — each LiveView process re-renders independently and they buy their way out with cores — so being single-threaded pushes us toward the better algorithm.
- **Yield to the loop every K connections**, or one large pass stalls every unrelated request. The cooperative-scheduling tax for not being on the BEAM.

**On using more cores.** Node can, and Stator already does where it fits: `sharp` (indie-blog `lib/media.ts:54`) runs in libvips' own native thread pool, off the event loop, with no `worker_threads`. Fan-out is a different shape: the unit of work is a **closure over live objects** — `itemRenderer`, `keyFn`, and each binding's read function are functions, and structured clone throws `DataCloneError` on a function — so it cannot cross a thread boundary without redesigning templates into serialisable data and re-instantiating them per worker. Per-item work is microseconds against a ~50–100µs postMessage round trip, and baselines must advance exactly once, in order.

The way Node scales a server across cores is `cluster`, and for Stator that is precisely the multi-replica problem: SSE fan-out and app machines are in-process, so two workers means two app-machine instances with connections split between them. **"Use more cores" and "run more replicas" are therefore the same problem**, answered by the deferred 1.x Redis backplane — not by a worker pool. Which is the argument for grouping: it is the lever available before that change.

One multi-core lever we do not use: Node's async `zlib` runs on the libuv threadpool, so compressing SSE payloads would be genuinely parallel work off the event loop — and it applies hardest to a resync, the largest thing we ever send, to the client least able to receive it.

**Memory.** The dominant term is not the outbox but the per-connection `RenderState`: every binding, its `lastValue`, and for keyed lists a `rowsByKey` of per-row binding arrays. A 500-row table across 1000 connections is the figure that will hurt, and it is true today independent of any of this. A coalesced outbox adds at most one pending entry per slot on top.

## Open

- The give-up threshold — blocked on step 2's measurements, deliberately.
- Whether grouping is worth building, and for what N. Measure before deciding: connections considered per pass, groups that would have formed, patch bytes, pass duration.
- Whether SSE payloads should be compressed, and whether that changes the resync calculus for slow clients.
- `pushToConnection` currently arms a `setTimeout` per push and clears it microseconds later on a healthy write. At N connections × dispatch rate that is pointless timer churn; it should arm only if the write has not settled after a tick, or use one coarse sweep. The queue's drain loop is the natural place for that.
- Whether ingestion after a sleep deserves a recipe. An effect that throws is dropped and its machine stays in the pending state (`effects.ts:174`), which is the documented contract, and a poll loop that re-arms only on success dies the first time the network is gone when it wakes. The dogfood incident is one data point. The pattern is a chart that re-arms on failure and reconciles on entry, the same "reload on entry" shape the hydration policy already recommends for durable facts.
