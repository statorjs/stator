---
"@statorjs/stator": patch
---

`stator test` no longer passes `--test-force-exit`, and a dev app's `close()` shuts the server it listened on.

With `--test-force-exit`, Node ends each test file's process the moment its tests finish, before the results still in the pipe to the runner are written. The runner counts only what arrived, so tests at the end of a file could vanish from a run with no failure: the framework's own suite reported one test too few in one run out of four. Without the flag the count is the same on every run.

The flag was there so a test that left a server open could not hang the run. The framework's own cause of that is fixed: `DevApp.close()` left the HTTP server from `listen()`, and its open connections, running. It now closes them and runs the boot teardown. A test that leaves something else open makes the run wait; close it in `after()`, or pass `--test-force-exit` yourself.

`CachedStore` gains `close()`, which closes the store it wraps. A cached Redis session store (`sessionStore({ cache: true })`) had no way to release its connection, which also kept a test file that built one from exiting.
