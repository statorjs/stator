---
"@statorjs/stator": patch
---

A half-open live connection can no longer starve the pages behind it. Every push to a live page is bounded now, and fan-out sends to every connection at once instead of one after another.

A write to a live socket resolves and a write to a closed one rejects, but a write to a **half-open** one does neither once its buffer is full: when a remote laptop sleeps or a NAT drops the mapping, no FIN ever arrives and the socket still looks writable, so the promise simply never settles. Fan-out awaited each connection's write serially with no deadline, so one such connection stalled the loop and every connection registered after it received nothing until the kernel gave up on the socket, many minutes later, or the same page reconnected and evicted it. On the session dispatch path the same stall ran into the session lock's thirty-second backstop, so the dispatching page saw an error after every mutation while a dead connection sat ahead of it.

- Every push now has a deadline (`STATOR_SSE_WRITE_TIMEOUT_MS`, default 5000). On a timeout the connection is dropped rather than retried. The client reconnects and gets a full resync, which is cheap by design. A write to a socket with buffer space resolves at once regardless of the peer, so the deadline fires only when the buffer has stayed full for the whole window, not on a merely slow client.
- Fan-out sends to connections **concurrently**, so a slow or dead client no longer delays the connections behind it. Recompute stays sequential because it advances each connection's diff baseline, and all sends still complete before the dispatch returns, so the next dispatch cannot interleave with this one's writes.
- The heartbeat goes through the same bounded path, so a wedged connection is reaped within a ping interval even when the app is idle and no dispatch would otherwise notice.
- The dev server's rebuild broadcast is bounded the same way.
