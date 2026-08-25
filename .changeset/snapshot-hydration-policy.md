---
"@statorjs/stator": minor
---

Sessions never outlive the code that made them. Every persisted machine snapshot is now stamped with a hash of the machine's code — the machine file plus every module it reaches, tree-shaken — and hydration discards a snapshot whose hash no longer matches the running machine, starting that machine fresh (logged once per machine, then at 10, 100, …). A renamed state can no longer strand a session in a state the chart doesn't have, and a session can no longer keep running under guards it wasn't created under. The rule is identical in development and production and for every Store.

**This release resets all persisted machine state once**, because existing snapshots carry no hash. From here on, a machine's sessions reset only when that machine's code changes, and `stator build` prints which machines each deploy resets (`machine code changed — sessions reset on deploy for: …`). Machine state is working state with a TTL, not persistence: anything whose loss would be an incident belongs in your own store, written by an effect and reloaded by an entry effect — see the persistence guide.

Mechanics: `stator build` hashes every machine in one esbuild pass and fails the build if a machine's closure can't be bundled (so an import problem surfaces in CI, not at a production boot); the hashes ship in `stator-manifest.json` and `stator start` consumes them. `createApp` accepts `machineHashes` (`loadProductionHead(dist).machines`); without it, machines are hashed live at boot, as the dev servers do. `Snapshot` gains optional `format` and `code` fields; `BuildResult` gains `machines`, `machineHashMs`, `resetMachines`. `persist: true` app machines follow the same rule: they survive restarts while their code is unchanged.
