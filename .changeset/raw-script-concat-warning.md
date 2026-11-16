---
'@statorjs/stator': patch
'stator-vscode': patch
---

`stator check` and the language server now also warn when a `+` concatenation containing a `<script` tag is passed straight to `raw()`, such as `raw('<script>' + data + '</script>')`. Variables and function calls passed to `raw()` stay silent.
