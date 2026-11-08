---
"stator-vscode": patch
---

Compile errors in `.stator` files are underlined in the right place in two cases that were off before: a template error that follows a `<script is:inline>` (it used to land on the script's line), and a frontmatter error in a fence that opens with blank lines (its column was shifted). The bundled compiler also gained source-map support for the runtime, which the extension does not use.
