---
'stator-vscode': patch
---

The language server reports the compiler's new located errors: a misplaced `child="x"` marker, a dynamic attribute on an island root, and JSX (or any syntax error) in frontmatter, which the virtual TSX no longer models as valid code.
