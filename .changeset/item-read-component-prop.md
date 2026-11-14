---
"@statorjs/stator": patch
---

Passing an item read to a component, as in `<RowSeats seats={read(row, (r) => r.seats)} />`, is a compile error in `stator dev`, `stator check` and `stator build`, naming the component and the prop. It used to render the attribute as `"[object Object]"` with no live binding. A hand-written template that passes one to an island fails at render with the same advice: pass a machine read, which an island takes as a live attribute, or render the field inline in the row.
