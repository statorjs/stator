---
"create-stator": minor
---

The scaffolder and its starters, readied for Stator 3.

- A scaffolded app depends on `@statorjs/stator` `^3.0.0`.
- It refuses to run on a Node older than 24, the framework's floor, before it creates anything.
- A scaffolded app starts at version `0.0.0` and no longer carries files that belong to the framework's repository (an example's changelog and design notes).
- The next-steps note points at `.env.example` when the template has one.
- Every starter declares `engines.node >= 24`, uses `@types/node` 24, and drops the unused `tsx` dependency. `desksmith`, `live-poll` and `weather` have a README; the `minimal` README named a `typecheck` script that does not exist.
- The package has a README.
