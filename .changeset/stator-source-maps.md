---
"@statorjs/stator": minor
---

`.stator` files get source maps. The compiler maps its server module back to the `.stator` source: frontmatter line for line, and each template expression and component call at the position it is written. The dev loader chains the map through esbuild and `stator build` inlines it in every compiled `.stator.ts` sibling, pointing back at the app's own file, so stack traces and editor breakpoints land on `.stator` lines in dev and production alike. `compile()` takes a new `sourceMap: { source }` option and returns the map. Template diagnostics after a `<script is:inline>`, and frontmatter diagnostics in a fence that opens with blank lines, now report the right position too. An island's server fence and client script are not mapped yet.
