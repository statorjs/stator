---
"stator-vscode": patch
---

Bundled compiler update: `.stator` language support picks up the inline-whitespace fix, so an interpolation like `{count} unsaved` keeps its space. The extension bundles the Stator compiler at build time, so its shipped output tracks this fix — no editor-facing feature change.
