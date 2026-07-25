---
"@statorjs/stator": patch
---

class:list and style:list specs re-resolve their machine reads against the current proxy on fan-out recompute — a long-lived SSE connection previously composed the attribute from the actor frozen at connect time, so the attribute never patched over a live connection.
