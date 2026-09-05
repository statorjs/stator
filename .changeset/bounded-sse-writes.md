---
"@statorjs/stator": patch
---

A sleeping laptop can no longer freeze a session. Pushes to a live page are bounded now, so a connection that stops draining is dropped instead of stalling everything behind it.

A write to a live socket resolves and a write to a closed one rejects, but a write to a **half-open** one does neither: when a machine sleeps or a NAT drops the mapping, no FIN ever arrives, the socket still looks writable, and the promise simply never settles. Fan-out awaited each connection's write with no deadline, and fan-out runs inside the session lock — so one sleeping tab held that lock forever. Every later request for that session queued behind it, including the reconnect whose initial sync would have repaired the page. The visible symptom was a live list frozen with rows that no longer existed, which reconnecting could not fix; the list diff was never the problem.

- Every push now has a deadline (`STATOR_SSE_WRITE_TIMEOUT_MS`, default 5000). On a timeout the connection is dropped rather than retried — the client reconnects and gets a full resync, which is cheap by design.
- Fan-out sends to connections **concurrently** instead of one after another, so a merely slow client no longer adds its latency to every connection behind it. Recompute stays sequential because it advances each connection's diff baseline, and all sends still complete before the dispatch returns: fan-out holds the session lock so the next dispatch cannot interleave, and keyed insert/remove/move are positional, where out-of-order delivery would corrupt a list rather than merely stale it.
- The heartbeat goes through the same bounded path, so a wedged connection is reaped within a ping interval even when the app is idle and no dispatch would otherwise notice.
- The dev server's rebuild broadcast is bounded the same way.

Found by dogfooding: a list-heavy live app went stale after the machine it was running on slept.
