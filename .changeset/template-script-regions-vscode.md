---
'stator-vscode': patch
---

The editor sees the right regions in a `.stator` file when tag text appears inside an expression, a string, a comment or the frontmatter: `<script>` or `<style>` text there is no longer taken for a component block (before, a frontmatter string containing `<script>` could leave the editor with an empty template). A string or template literal containing a `<script` tag passed straight to `raw()` now shows a warning, matching `stator check`.
