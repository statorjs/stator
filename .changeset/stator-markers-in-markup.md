---
'@statorjs/stator': patch
'stator-vscode': patch
---

A `Stator.*` marker in template markup (an interpolation, a prop or a directive value) is now a located compile error, so `stator dev`, `build` and `check` all report it instead of the page throwing `ReferenceError: Stator is not defined` at render. A route is told to assign the value to a const in the frontmatter; a component using a route-only marker is told to read it in the route and pass it down as a prop.
