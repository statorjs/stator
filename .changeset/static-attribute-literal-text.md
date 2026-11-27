---
'@statorjs/stator': patch
---

Static attribute values with quotes, `${` or a backtick render as written, and entities in a component's string props are decoded as they are on elements. `${…}` inside a quoted attribute is now literal text: write `title={`…`}` to interpolate.
