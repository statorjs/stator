---
'@statorjs/stator': minor
---

`stator build:lib [dir]` compiles a component library for publishing: every `.stator` under the directory (default `src`) to its sibling `.stator.ts` and `.css`, `.stator` imports between them rewritten to the compiled siblings, and one stylesheet aggregated for the package's `./components.css` export from the directory's `index.ts` barrel — every component's CSS when there is no barrel. It is the operation the framework's own `<Image>`/`<Picture>` were already published with, now owned by the CLI so a library no longer scripts it against the internal `compiler` subpath. `compileLibrary()` on `@statorjs/stator/build` is the same operation as a function. Islands compile, but a consuming app can't discover islands from a package yet, and the command says so.
