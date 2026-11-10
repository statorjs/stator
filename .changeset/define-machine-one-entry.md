---
"@statorjs/stator": major
---

`defineMachine` is exported from `@statorjs/stator/machine` only. `@statorjs/stator/server` re-exported it, so a machine was written against one entry or the other, and the choice looked like it said where the machine ran. It never did: both were the same function. A machine now imports `defineMachine` from the one place, whether it is registered on the server, run in a client island with `use()`, or both, and nothing in the file marks it as server or client.

Migrating: change `import { defineMachine } from '@statorjs/stator/server'` to `import { defineMachine } from '@statorjs/stator/machine'`. An import that also takes server exports splits in two: `import { defineMachine } from '@statorjs/stator/machine'` and `import { sessionStore } from '@statorjs/stator/server'`. TypeScript reports each import left behind as a missing export. The machine types (`MachineDef`, `DefineMachineConfig`, `ActionHelpers` and the rest) are still exported from `/server`, and from `/machine`.

`@statorjs/stator/server` is server code and an island's bundle cannot import it. A module in an island bundle that does is refused by `stator dev`, `stator check` and `stator build`, naming the module and what it imported.
