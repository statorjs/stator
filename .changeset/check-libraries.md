---
"@statorjs/stator": minor
---

`stator check` checks a component library. `stator check src` regenerates the declarations and virtual TSX for every `.stator` under `src`, written under the root's `.stator/` mirroring `src/`, so a library's tsconfig includes `.stator/check/**/*.tsx` and sets `rootDirs: [".", ".stator/types", ".stator/check"]` the way an app's does. The contract check walks `<dir>/routes` when it exists, `--routes <dir>` names another, and a library without routes skips it with a note. `stator build:lib` runs the same check first and compiles nothing when it fails, so a component with a type error can't be published. `checkStack` takes `{ dir, routesDir }` and `syncTypes` takes `{ dir }`.

`stator check` now typechecks each island's compiled client module too, in apps and libraries alike, so the wiring the compiler generates for a template is held to the class: `on:click={save}` fails when `save` takes something other than the event. Errors in generated code are reported at the `.stator` line they came from, not at `.stator/check/…`. The generated wiring typechecks the way passing the method as a listener does, so a handler taking no argument or a narrower event is accepted; the compiled `.stator.client.ts` carries those type assertions, which erase to the same calls as before.
