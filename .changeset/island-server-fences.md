---
"@statorjs/stator": minor
---

Island files may now carry a frontmatter fence. It runs server-side, per shell render — exactly a server component's contract — and its bindings are in scope for the template; the `<script>` never sees it, in either direction. Fences are for server work the island owns (imports, computed constants, queries); per-use data stays props. `Stator.*` markers are rejected in island fences with located errors, and a fence binding sharing a name with a `use()` field is a located error rather than a precedence rule.
