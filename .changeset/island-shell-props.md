---
"@statorjs/stator": minor
---

Islands get typed props and typed attrs.

- **`Stator.props<P>()` in an island's fence** declares the props its shell takes beyond its attrs. It was a compile error. An island that declares them is closed: its props are `P` plus its `static attrs`, so a misspelled or missing prop at the use site is a type error, and the template is checked against them. An island that declares none stays open, as before.
- **`this.attrs` is typed from `static attrs`.** `this.attrs.unitPrice` is `number | undefined`, a `Boolean` attr is `boolean`, a custom coercer gives its return type, and an undeclared attribute is a type error. It was `Record<string, unknown>`. Code that read an undeclared attribute through `this.attrs` now fails `stator check`: declare it, or read it with `this.attr(name)`. `AttrsOf` is exported from `@statorjs/stator/client`.
- **Fence types are usable in the `<script>`.** A type alias, interface or `import type` in the fence that the script names is restated in the client module; types erase, so nothing follows them into the bundle.
- **A fence value used in the `<script>` is a compile error** naming it. It was a `ReferenceError` in the browser.
