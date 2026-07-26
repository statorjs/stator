---
"stator-vscode": patch
---

Templates no longer show false syntax errors on HTML comments, `is:inline` scripts, and unclosed void elements. The language server applies HTML-to-TSX compatibility before typechecking, with exact source mappings — diagnostics land on the right characters.
