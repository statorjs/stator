---
"@statorjs/stator": minor
---

`read(item, selector)` inside an `each` makes an item field live: a content change patches just that field in place instead of re-rendering the row (keyed and non-keyed), and identity churn no longer re-renders it. `read()` stays the one marker for live data — a plain `{item.field}` still renders once.
