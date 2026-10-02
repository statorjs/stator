---
"stator-vscode": patch
---

Fixed the scoped-styles compiler to put the scope attribute INSIDE a `:where(...)` selector's own arguments instead of appending it after, so `:where(...)` keeps the zero specificity it's meant to guarantee. This changes the compiled CSS the extension shows (hover, diagnostics, virtual code) for any `.stator` component whose `<style>` block uses `:where()`.
