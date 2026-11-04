---
title: 'Snapshot policy follow-ups: package versions in the hash, an engine hash, seed from session, an honest deploy report'
status: draft
created: 2026-11-04
updated: 2026-11-04
area: engine
---

## What and Why

Recorded 2026-11-04 from a tonysull.co production incident. The site keeps sessions in Redis so that a deploy keeps the owner signed in. The deploy that bumped Stator 2.13.1 → 2.14.0 (tonysull.co `5256d80`) signed the owner out: the `sid` cookie and the `{ role: 'owner' }` claims survived in Redis, but `OwnerMachine` came back at its initial state with `authed: false`, and `/admin` renders the sign-in form from that flag. Reading it as "the auth machine's code changed" was wrong. Three defects in [[machine-state-is-working-state-snapshot-hydration-policy]] and one in its reference idiom explain it, and they pull in opposite directions.

1. **Every Stator release resets every machine in every app.** `server/machine-hash.ts:140` folds `statorVersion` into each digest. 2.14.0 changed only the template splitter — nothing that executes as part of a machine — and reset all six of tonysull.co's machines. The parent spec filed framework resets under "rare; changelog"; in practice it is every release, and the 2.14.0 changelog says nothing about it.
2. **Package-shipped machines are invisible to the hash.** tonysull.co's `machines/owner.ts` is `export * from '@indiepub/stator/machines/owner'` — the layered shape from [[no-route-injection-package-handlers-mount-files-and-the-layered-indiepub-shape]], where chart logic upgrades via npm. Bare specifiers are external (`machine-hash.ts:108`), so the measured bundle is 139 bytes of re-export and the digest is a function of the two version strings alone. An `@indiepub/stator` bump that rewrites OwnerMachine's guards does not reset its sessions — the false negative the principle promised never to allow. Only a removed state is caught, via `state-missing`. The module's header comment says package versions are hash inputs; only Stator's and esbuild's are.
3. **The deploy report is silent where it matters.** `build/build.ts:211` computes `resetMachines` only when a previous `dist/stator-manifest.json` exists on disk, and `cli/commands/build.ts:88` prints nothing otherwise. CI builds from a fresh checkout with `dist/` ignored, so the line never prints, and silence reads as "nothing reset". The Forgejo log for this deploy shows `6 machines hashed in 8 ms` and no reset line.
4. **The reference idiom mirrors sign-in into working state.** `with-auth`'s AuthMachine and IndiePub's OwnerMachine both keep sign-in as context (`userId`/`role`, `authed`) and mint claims as a projection *from* the machine. At a reset the derivation has to run the other way — claims are the durable fact and the machine is the cache — and neither machine does it. The persistence guide's reload-on-entry example is a cart; sign-in is the case every app hits first, and the one where the entry-effect rhythm (first render shows the fresh state, the completion patches in) is a visible sign-in flash on every deploy.

Migration is still the wrong tool. The fact was never lost — the claims survived — and a `migrate(snapshot, from)` hook carries a snapshot across a code change, which is opting out of the policy; it cannot address defect 1 at all. The parent spec's reserved trigger has not fired.

## Success Criteria

- A machine that imports a package resets when that package's installed version changes and does not reset when an unrelated package's version changes. Unit tests over `hashMachines` alone, with a fake `node_modules` package: bump → hash moves; unrelated bump → equal. A machine importing nothing beyond the framework keeps today's digest byte for byte, so plain machines do not reset on the upgrade that ships this.
- A bare specifier that resolves to app code (a tsconfig `paths` alias) is bundled and content-hashed like a relative import, not externalized.
- A Stator release whose changes are outside the engine and the actor host does not reset sessions. A unit test pins the engine hash to the engine's closure, not to the package version.
- A session machine can declare how to seed its context from the session at a fresh start, synchronously, before the first render. The seed applies for a new session and after a reset alike, never when a snapshot hydrates. `with-auth` and the persistence guide use it for sign-in.
- `stator build` says in one line when it had no previous manifest to compare against, and accepts one from outside the checkout.

## Constraints

- The hash stays a measurement: no bundle written, no `node_modules` bundled. Package code is versioned, not content-hashed — `sharp` and `node:sqlite` cannot bundle, and the parent spec's reasons for never running per-machine bundles stand.
- Digest stability for machines a fix does not concern: fix 1 appends package ids only when a machine reaches at least one package other than the framework, so plain machines keep their digest and do not reset on the upgrade.
- No migration hook. Each fix either tightens what "the code" means or re-derives working state from a durable fact the host already holds.
- Store-agnostic and no environment branching, as the parent spec requires.

## Approach

### Fix 1 — package versions into the hash (correctness)

The externals plugin resolves a bare specifier with esbuild's own resolver (`build.resolve`, with a `pluginData` marker so the plugin does not re-enter itself) before deciding what it is. Four outcomes:

- `@statorjs/stator` and Node builtins: external, no dep entry. The framework is an explicit input already (its version today, its engine hash after fix 2), and builtins belong to the runtime.
- Resolved under a `node_modules` directory: external, and the nearest `package.json` above the resolved file yields a `name@version` dep entry. pnpm's real paths land in `.pnpm/<name>@<version>…/node_modules/<name>/`, so the walk finds the package's own manifest, never the app's.
- Resolved elsewhere — a `paths` alias into app code, or a workspace-linked package: bundled and content-hashed. Workspace links are the one case where an edit without a version bump is hashed by content rather than missed.
- Unresolvable: external with no dep entry, exactly as today. The hash never introduces a build failure the loader would not also hit.

Per machine, the dep entries reachable from its graph (`metafile.inputs[*].imports` with `external: true`, mapped through the resolutions recorded during the build) are sorted, de-duplicated and appended to the digest after the bundle bytes. The package boundary is the version: a package's own dependency bumps do not show, which its version is expected to carry.

Consequence stated plainly: a dep bump that touches nothing a machine uses still resets that machine. Over-reset, which the principle permits; a miss, which it does not.

### Fix 2 — an engine hash instead of `statorVersion`

What executes as part of a machine is `engine/*` plus the host pieces that build actors and run effects and timers (`server/session-runtime.ts`, the effect runner, `server/timers.ts`, `server/snapshot-policy.ts`, the machine store), not the compiler, CLI, language server, image endpoint or dev servers. Measure that closure with the same esbuild pass at package build time and ship the digest as a constant the hash reads, falling back to a live computation over the installed package's own files when the constant is absent (the monorepo, tests). `esbuildVersion` stays: it is the production TS loader. A compiler-only release then resets nothing, and the build-time report prints `no machine code changed` without anyone remembering a changelog line. The exact file set is an open question below; the test pins it so the set changes deliberately.

### Fix 3 — seed from the session at a fresh start

Claims are in memory before hydration — `server/http.ts:291` eager-loads them when a cookie resumes a session — and the engine already has the seam: `actor.seed(partial)` (`engine/actor.ts:16-19`), used for the island's deferred attribute seed. A session-machine def gains `seed?: (session: EffectSession) => Partial<C>`. `SessionRuntime.loadOne` and `rehydrate` call it only when `reconcileSnapshot` returned `undefined` (a new session or a reset), before `start()`. Synchronous, no I/O, no event, nothing on the wire, no flash. The entry effect remains the idiom for facts that need a database read. Docs: the persistence guide leads with the sign-in case; `with-auth`'s AuthMachine seeds `userId`/`role` from its own claims; IndiePub's OwnerMachine seeds `authed`.

### Fix 4 — an honest deploy report

Print `no previous manifest — cannot say which sessions this deploy resets` when the diff cannot run. Then let the comparison come from outside the checkout: `stator build --previous <path>` fed by a pipeline artifact of the last deployed manifest, or a manifest endpoint the pipeline fetches before building. The build itself does not network. The runtime's rate-limited reset warn remains the ground truth after a deploy.

## Alternatives Considered

- **Bundle `node_modules` into the measurement.** Exact for packages that bundle, fatal for the ones that do not (`sharp`, native addons), and large. Version-as-input is the safe reading.
- **Hash the lockfile.** Resets every machine on any dependency change anywhere in the app. Per-graph package ids give the same guarantee with a tighter cut.
- **Keep `statorVersion` and promise a changelog line.** The promise was already broken by 2.14.0, and the cost lands on every app on every release.
- **Entry effect for sign-in restore.** Works today and is documented, but the rhythm is a sign-in flash on every deploy for an auth gate — a fact the host already holds should not take a round through the effect queue.
- **`version` + `migrate(snapshot, from)`.** Still rejected, see above.
- **Commit `dist/stator-manifest.json`** so CI has a previous manifest. A build artifact in git, and wrong after a hotfix deployed from another branch.

## Open Questions

- ~~**Engine closure file set (fix 2).**~~ **Resolved 2026-11-04.** Entries (whole export surface counts, because app code or the HTTP layer calls into them): `engine/index.ts`, `server/define-machine.ts`, `server/session-runtime.ts`, `server/machine-store.ts`, `server/effects.ts`, `server/timers.ts`, `server/snapshot-policy.ts`, `server/app-dispatch.ts`. Bundled when reached (tree-shaken to what the entries use): the rest of `engine/*` plus `server/app-store.ts`, `dispatch-context.ts`, `instance-proxy.ts`, `machine-hash.ts` (only the def→hash registry survives tree-shaking), `reads-helpers.ts`, `session-lock.ts`, `session.ts`, `store.ts`. Cut (reached, externalized under a stable `stator:` id): `engine/describe.ts` (the inspector's def→data walk — inspection, not execution), `server/logger.ts`, `server/render-context.ts`, `server/sse.ts` (fan-out and the renderer's diff path). Both sets are pinned by `tests/engine-hash.test.ts`; a new edge fails the test until it is sorted into one or the other. Measured: 19 modules bundled, ~25 ms once per process.
- **Workspace-linked packages that cannot bundle (fix 1).** Bundling them is correct and cheap today; if an app links a package with a native dependency, the fallback should be version-as-input with a logged line, not a build failure. Decide when it bites.
- **`seed` for app machines (fix 3).** They have no session; `seed` is session-only until an app shows a need.
- **Where the previous manifest comes from (fix 4).** Artifact or endpoint; the Forgejo + Fly pipeline is the first consumer.

## Implementation Notes

- Fix 1 — **landed 2026-11-04** on `fix/machine-hash-package-versions`. `server/machine-hash.ts`: the externals plugin calls `build.resolve` (guarded by a `pluginData` marker) before classing a bare specifier; `@statorjs/stator` and builtins stay external with no entry; a path under `node_modules` is external and `packageIdAbove` walks to the nearest *named* `package.json` (pnpm real paths land in the package's own dir); anything else is returned as a bundled path; a resolve error falls back to external with no entry. `walkGraph` (was `closureOf`) also collects `{ importer, specifier }` for externals, mapped through the resolutions recorded during the build; sorted unique `name@version` entries are appended to the digest after the two version strings, only when non-empty. `MachineHash` gains `packages`. Verified against `main`: the five weather machines (framework-only) keep their digests byte for byte; all six tonysull.co machines change and report `@indiepub/stator@1.0.0-beta.53`. Tests (7 new in `tests/machine-hash.test.ts`): packages reported and kept out of `inputs`; version bump → moves, revert → equal; unrelated package bump → equal; code change without bump → equal; plain machine has no packages; tsconfig `paths` alias → bundled, content-hashed, in `inputs`; uninstalled package → external, no throw. Docs: persistence guide's "what resets a machine" sentence. Changeset: patch.
- Fix 2 — **landed 2026-11-04** on `fix/machine-hash-package-versions`. `server/machine-hash.ts`: `engineHash()` (memoized per process) bundles `ENGINE_ENTRIES` from the installed package's `src/` with `tsconfigRaw: {}` (the app's tsconfig must not shape the framework's bytes) and the shared `MEASURE` options; in-package modules outside `engine/*` ∖ `ENGINE_CUT` and `ENGINE_HOST` are cut as `stator:<rel>` externals, bare specifiers external with no version; the digest is sha256 over the outputs in path order plus `esbuildVersion`; returns `{ hash, inputs, cut }`. `hashMachines` awaits it in parallel with the machine build and folds `engine.hash` where `statorVersion` used to go; the `package.json` read is gone from the module. Verified: the five weather machine hashes are byte-identical with `package.json` at 2.14.0 and at a fake 99.0.0; all hashes move once against `main` (formula change, stated in the changeset). Tests: `tests/engine-hash.test.ts` (deterministic + memoized; bundled list pinned; cut list pinned; nothing from compiler/cli/build/dev/template/wire/client or `server/http|render|routing|sse|…` bundled; still an input to a machine hash). Docs: persistence guide's reset rule names the engine/actor host instead of "a framework upgrade". Changeset: patch.
- Fixes 3, 4: not started.
