---
"@statorjs/stator": patch
---

Logs show a session as a short hash (`#3f9c1a0b7e2d`) instead of its id. The id is the session's credential, and several warnings and errors logged at the default production level (a dropped live connection, a lock timeout, a snapshot reset) printed it in full, so anyone with log access could resume that session. The same session always hashes the same, so a session's lines can still be followed; `@app` and `@anonymous` are shown as they are.
