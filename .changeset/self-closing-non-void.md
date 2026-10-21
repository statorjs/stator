---
"@statorjs/stator": patch
---

A self-closing non-void element in a template (`<div />`, `<my-widget />`) now compiles to an explicitly closed element (`<div></div>`). HTML has no self-closing syntax for non-void elements, so browsers read `<div />` as an open tag and nest every following sibling inside it. Void elements (`<br />`, `<img />`, `<input />`) emit without the meaningless trailing slash (`<br>`).
