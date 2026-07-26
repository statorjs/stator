---
"@statorjs/stator": patch
---

The circular-import subscription error now recommends the read/write split (a third machine reading both sides) and no longer suggests defining both machines in one module, which directory discovery — default exports only — cannot load.
