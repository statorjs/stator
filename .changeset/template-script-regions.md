---
'@statorjs/stator': minor
'@statorjs/language-server': patch
---

Only top-level `<script>` and `<style>` elements are component regions now. The splitter used regexes that also matched tag text inside a `{…}` expression, a string or template literal, a comment or the frontmatter, so `` {raw(`<script type="speculationrules">${json}</script>`)} `` or a code sample like `{'Use <script>…</script>'}` was lifted out as a client component and broke the template. A lexer now reads expressions, strings, comments and nested JSX the way the TSX parse does. The language server benefits too: a frontmatter string containing `<script>` no longer leaves the editor with an empty template.

`stator check` and the language server now warn when a string or template literal containing a `<script` tag is passed straight to `raw()`. Such a script isn't processed or bundled, and interpolated values aren't escaped for script content; use a component like `<JsonLd>` for data blocks, or a top-level `<script>` for client code. `raw(variable)` stays silent as the deliberate escape hatch. Warnings don't fail the check. New export: `compileWarnings` from `@statorjs/stator/compiler`.
