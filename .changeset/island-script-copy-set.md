---
"@statorjs/stator": patch
---

`stator build` copies what only an island's `<script>` imports. The copy set was derived from the server module graph alone, so a top-level directory reached only from an island script was missing from `dist/` and the island bundle step failed with `Could not resolve`. The walk now follows each island's script. A package only a script imports is still left out of the artifact's dependencies: the island bundle already holds it.
