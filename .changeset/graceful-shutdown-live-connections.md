---
"@statorjs/stator": patch
---

Stopping a server with a live page open no longer hangs. `SIGTERM` now exits in milliseconds instead of stalling until the platform gives up and kills the process.

`server.close()` stops accepting new connections and then waits for every existing one to end — which never happens for a live route, because an SSE response is a single request that lasts as long as the page is open. Waiting on it meant a `systemctl stop` or a container rollover sat there until the kill grace expired (systemd's default is 90 seconds) and the process died by signal, reported as a failed stop. In dev it meant Ctrl+C did nothing until you pressed it twice.

Live connections are hung up rather than waited for, which is what every graceful-shutdown implementation converges on — Go's `http.Server.Shutdown` says outright that the caller must close long-lived connections itself. Dropping a live channel is cheap by design: the browser reconnects and re-syncs from the server's baseline, or reloads if it comes back to a newer build.

- The drain, in order: stop accepting, run the `boot.ts` teardown, hang up every live connection, then wait for in-flight requests. Teardown used to run *before* the server stopped accepting, so a request could arrive after its sources were unsubscribed.
- **`STATOR_SHUTDOWN_TIMEOUT_MS`** bounds the wait for real request work, default `5000`. When it expires the remaining sockets are destroyed and the process exits anyway, warning with the deadline it passed. A wedged teardown can no longer hold the process either — it is inside the deadline, and one that throws is logged instead of aborting the drain.
- Idle keep-alive sockets are reaped on a tick while the drain waits, not once up front. A hung-up stream's socket becomes idle a moment *after* the stream ends, and until something closes it, `close()` stays pending for as long as the client's own keep-alive timeout — four extra seconds in practice.
- A second signal still exits immediately, and a signal still exits `0`.
