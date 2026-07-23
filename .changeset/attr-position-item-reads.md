---
"@statorjs/stator": minor
---

Item reads work in attribute position — `checked={read(item, (i) => i.done)}`, `style={read(item, (i) => `width: ${i.pct}%`)}` — with the same semantics as machine attr reads (false/null removes the attribute, true renders it bare), patching the row's stable element id across moves.
