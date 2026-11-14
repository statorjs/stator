---
"@statorjs/stator": patch
---

Three template-escaping edges are closed:

- A URL attribute is checked whole at its closing quote, so a `javascript:` scheme split across interpolations in a hand-written `` html`<a href="${a}${b}">` `` is blanked like one written in a single value. `.stator` templates compile `href={…}` to one interpolation and were not affected.
- `data`, `manifest` and `srcset` get the same scheme check as `href` and `src`.
- `{...spread}` keeps only keys that are valid attribute names and drops `on*` event-handler names, so a bag built from data (a query string, stored JSON) can't write markup or an inline handler.
