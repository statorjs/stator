---
"stator-vscode": minor
---

The editor now flags typos on native HTML attributes — `<button typ=…>` is underlined instead of silently accepted — and understands components that extend a native element via `HTMLAttributes<Tag>`. Custom-element islands and SVG stay unchecked.
