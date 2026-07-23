---
"@statorjs/stator": patch
---

An item read is owned by its `each` row, and the compiler now enforces the placement that implies: `read(item, …)` inside a `when`/`match`/`defer` arm, reading an outer item from a nested `each`, or inside a `class:list`/`style:list` spec are compile-time errors that name the fix. Arms re-render without their row — previously this crashed recompute at runtime.
