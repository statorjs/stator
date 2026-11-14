---
"@statorjs/stator": major
---

`stator dev` binds `127.0.0.1` unless `host` is set. It listened on every interface, so anyone on the same network could open `/@stator/inspect` and read every app machine's state. The new `--host <addr>` flag sets the bind address for `dev` and `start` (`--host 0.0.0.0` to test from a phone), and the dev banner shows a network URL only when the server is reachable on one.
