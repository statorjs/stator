---
'@statorjs/stator': patch
---

The machine code hash now counts the packages a machine's code reaches. A bare import is resolved before it is classed: a package under `node_modules` stays external (never bundled) but its installed `name@version` is a hash input for every machine whose graph reaches it, so a chart re-exported from a package (`export * from '@acme/charts/owner'`) resets its sessions when that package is bumped — before, such a machine measured as a one-line re-export and a package bump that rewrote its guards never reset anything. A bare specifier that resolves to app code (a tsconfig `paths` alias) or a workspace-linked package is now bundled and hashed by content. Machines that reach no package keep their previous digest. `MachineHash` gains a `packages` list.
