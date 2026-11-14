---
"@statorjs/stator": patch
---

A row a keyed `each()` inserts after the page rendered keeps its item reads live. When the list first rendered with no rows carrying a `read(row, …)` (an empty list, typically), rows added later rendered correctly but their item reads were never tracked, so an edit to one of them never reached the page until it was reloaded.
