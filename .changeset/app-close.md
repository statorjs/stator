---
"@statorjs/stator": minor
---

The production app can be stopped, and `listen()` says which port it bound.

- **`app.close()`** on the app `createApp` returns. It does what `stator start` does on `SIGTERM`, without exiting the process: stops accepting, runs the `boot.ts` teardown, hangs up live streams, gives in-flight requests a bounded deadline, and resolves once the port is free. The signal handlers `listen()` installed are removed, and the app can `listen()` again. Until now a server started with `listen()` could only be stopped by a signal.
- **`listen()` resolves with `{ port }`** on both `createApp` and `createDevApp`, where it resolved with nothing. `listen(0)` takes a free port from the OS, so a test that needs a real server no longer has to pick a number and hope.
