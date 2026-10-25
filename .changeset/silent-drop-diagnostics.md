---
'@statorjs/stator': minor
---

Three things the compiler used to accept and silently get wrong are now located compile errors, each found building a real app:

- **`child="x"` anywhere it can't be read.** The marker is only read off a direct element child of a component tag. Inside a `{…}` expression (`{cond ? <div child="top"/> : null}`), nested deeper, at the template root, or on a component tag itself, it used to fall into the default slot or become an ignored prop with no warning. The error names the shape that works: put the condition inside the slotted element.
- **A dynamic attribute on an island's root.** `<markdown-editor data-mode={mode}>` compiled and typechecked, and the shell rendered the root without the attribute. The root is rendered from the use site's props, so a dynamic value belongs on an inner element or in `static attrs`; the error says so and points at the attribute.
- **JSX in frontmatter.** The fence is plain TypeScript, so `return <p>…</p>` lexed as a type assertion and failed only as esbuild's `Expected ")" but found "return"` on the emitted module, while `stator check` passed it. A syntax error in the fence now reports with TypeScript's own message at its line and column, with one targeted hint for the JSX shape (markup belongs in the template; a not-found page cascades to `routes/404.stator`). The editor's model stops making such a fence look fine, so the squiggle matches.
