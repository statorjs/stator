---
"@statorjs/stator": minor
---

Islands get source maps. An island's server fence and shell template map back to the `.stator` file like any server module, and its `<script>` maps line for line, with each wiring line the compiler generates (an `on:click` handler, a `read()` slot) mapped to the directive it wires. Dev island bundles chain the map and are no longer minified, so browser devtools show the island's own source and its variables under their own names, and `stator build` and `build:lib` inline it in the compiled `.stator.client.ts`. Compile errors inside an island's markup now report their position; they had none before.
