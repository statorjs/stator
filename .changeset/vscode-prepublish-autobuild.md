---
"stator-vscode": patch
---

Add a `vscode:prepublish` build hook so `vsce publish` and `ovsx publish` always rebuild the language-server bundle before packaging — publishing can no longer ship a stale `dist/`. (1.0.4 was published from a leftover pre-build and shipped without the frontmatter sync-scope language-server change; this cuts a fresh 1.0.5 carrying the current bundle.)
