---
"@statorjs/stator": patch
---

An island file's frontmatter was silently discarded — the shell either crashed at first render with a dangling identifier (fence bindings referenced in the template) or carried a fence that never executed. It is now a located compile error explaining the model: an island's shell renders from props, so server work belongs in the route or component that renders the island.
