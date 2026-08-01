---
"@statorjs/stator": patch
---

Fix JSX text whitespace: an inline space next to an interpolation is now preserved, so `{count} unsaved` renders with its space instead of `{count}unsaved`. Text after an expression was losing its leading space (the compiler skipped the text node's leading trivia); whitespace now follows JSX's own rules — inline spaces are significant, newlines and indentation between tags collapse.
