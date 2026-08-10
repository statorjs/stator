---
"@statorjs/stator": patch
---

`<time datetime={…}>` typechecks — the per-element attribute set was missing `time`'s `datetime`, so microformats `dt-published` markup was a compile error.
