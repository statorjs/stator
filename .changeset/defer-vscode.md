---
"stator-vscode": patch
---

Recognize the `defer` template construct in the editor: `defer(...)` is no longer reported as an undefined global, and a machine `read()` placed inside a `defer` arm is flagged inline as an error (matching the compiler's build-time check).
