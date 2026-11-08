---
"stator-vscode": patch
---

Compile errors inside an island's markup (an `on:click` with no handler, a misplaced directive) are underlined where they are written; before, they had no position and landed at the top of the file.
