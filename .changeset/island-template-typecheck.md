---
"@statorjs/stator": minor
---

An island's template is typechecked as the server shell it is, in `stator check` and in the editor. The virtual TSX held only the island's `<script>`, so the shell side of the template was never checked: a fence binding misused in it, a misspelled `use()` field, a `read()` fallback of the wrong type. The template is now emitted with the fence's bindings and the element class's members in scope. The shell's `props` are open, since an island declares only its attrs, and a callback over them (`props.rows.map((row) => …)`) is not an implicit-any error.

A `use()` handle on a `machine()` with no selectors no longer accepts every property: `read(qty, (q) => q.nope)` is an error.
