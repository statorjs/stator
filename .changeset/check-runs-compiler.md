---
'@statorjs/stator': minor
---

`stator check` now runs every `.stator` file through the real compiler before the `tsc` pass — the same call `stator dev` makes on import and the language server makes per edit — so the editor, `check` and `dev` reject the same inputs. A compile error reports as `file:line:col` with the compiler's code frame and counts in the final tally. `stator build` runs `check` first, so a template the dev server would refuse now fails the build before anything reaches `dist/`, instead of surfacing on the first request that imports it.
