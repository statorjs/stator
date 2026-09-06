---
"@statorjs/stator": patch
---

A dispatch no longer waits on any other page's socket. Every live connection now has its own write queue with a single drain loop, and fan-out queues patches and returns: the acting user's POST response is ready as soon as the recompute is, however many viewers there are and however slow their networks.

- Per-connection order is FIFO by construction, so back-to-back changes cannot reorder a keyed insert, remove, or move.
- The write deadline (`STATOR_SSE_WRITE_TIMEOUT_MS`) now measures one write at the head of the queue rather than the time since it was issued, so a burst behind a slow but healthy connection no longer trips it.
- A backlog over `STATOR_SSE_QUEUE_MAX_BYTES` (default 1 MiB, counting only what is waiting behind the write in flight) drops the connection, the same policy as a timed-out write: the client reconnects and resyncs. A single waiting item never trips it, however large.
- When the dispatching page's own channel already has a backlog, its patches ride that queue instead of the POST response, which then carries none. Two channels to one page must not reorder a positional list op. With an empty queue, the normal case, the response delivers exactly as before.
- The initial sync, the heartbeat, and the dev server's rebuild broadcast go through the same queue.
