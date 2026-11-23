---
title: 'The reads family rename ships as aliases: machines on routes, peers on machines'
status: draft
created: 2026-11-22
updated: 2026-11-22
area: runtime
---

## What and Why

One word names four things. `read(cart, …)` in a template is a live binding. `Stator.reads([...])` in a route fence declares which machines the page loads. `reads: [...]` on `defineMachine` declares which other machines a machine can see. `helpers.reads` is the map of those machines inside an action, guard or selector. On a command route the word is also wrong: `reads: [Cart]` on `defineApiRoute` is the list of machines the handler may `dispatch` to.

The rename was scheduled for 3.0 and did not land (ROADMAP, Surface hygiene). The proposal on record: `read()` keeps its name, route declarations become `machines`, the machine option becomes `peers`, `helpers.reads` becomes `helpers.peers`. This spec ships those names in a 3.x minor as aliases, deprecates the old ones, and records the 4.0 removal.

## Success Criteria

- Every old spelling keeps working through 3.x with no change in behaviour. The new spellings work in the same release:
  - `Stator.machines([...])` in a route fence;
  - `machines: [...]` on `defineRoute` and on both shapes of `defineApiRoute`;
  - `peers: [...]` on `defineMachine`;
  - `helpers.peers` in actions, guards and selectors.
- Declaring both spellings in one place is an error that names the one to keep.
- Old spellings are marked `@deprecated` in the types, reported as warnings by `stator check` (never errors), and logged once per process by `stator dev`.
- The editor shows the deprecation from the project's own types, and shows nothing on a project whose Stator predates the new names.
- First-party docs, examples and scaffold templates use only the new names, and do not switch before the release that accepts them is on npm.
- The release notes say which sessions reset, and why.

## Constraints

- Non-breaking at runtime. One type-level exception is known and listed under Open Questions (hand-built helper stubs in tests).
- `read()` is not touched.
- The frozen `BUNDLED_STATOR` shape in `compiler/virtual-code.ts` is not edited. It describes releases before 3.0, which only had `reads`.
- The extension's bundled compiler must accept both spellings for as long as any supported release has either.
- No internal field renames in the alias release. `route.reads` and `def.reads` stay the fields the server reads; see Approach for why.

## Approach

Verified against `main` at 3.0.3 (2026-11-22).

**The names.** `machines` on routes is confirmed. A data GET handler already receives `{ machines }` (`QueryRouteHelpers`, `server/routing.ts`), so `machines: [Polls]` beside `({ machines }) => machines.Polls` is one word for one thing, and on a command route it stops claiming the list is read-only. The collisions are real but benign: the `machines/` directory, `machinesDir`, `discoverMachines`, the inspector payload's `machines` key and `machineHashes` all mean "the app's machines", and a route's `machines` is a subset of exactly that. The one wrinkle is shape: `Stator.machines([A, B])` returns a tuple in order, while `{ machines }` in a data handler is a map keyed by name. That difference exists today between `Stator.reads` and `{ machines }`, so the rename does not add it.

`peers` is confirmed with two caveats. The relation is directional, not mutual: discovery sorts by it and throws on a cycle, and an app machine cannot name a session machine (`validateReads`, `server/discovery.ts`). And presence, when it is designed, will want a word for "the other connections on this page"; that word must not be `peers`. The alternative, `machines` on the machine option as well, is in Alternatives.

**There are six surfaces, not four.** The roadmap lists four. The code has two more that take the same word: `defineRoute({ reads })`, which is what hand-written page routes call and what the compiler emits for every `.stator` route; and `createActor({ resolveHelpers: () => ({ reads }) })`, the engine option tests use to stub a machine's dependencies (`examples/desksmith/tests/cart.test.ts`). `defineApiRoute` calls its option `reads` today on both overloads.

**Routes.** In `server/routing.ts`, `DefineRouteConfig`, `DefineApiRouteConfig` and `DefineQueryRouteConfig` each gain `machines?: TReads` and keep `reads?: TReads` with a `@deprecated` tag. `DefineRouteConfig.reads` is required today; it becomes optional so `machines` alone typechecks. One helper, `declaredMachines(config, where)`, returns the list from whichever key is set and throws when both are: `stator: defineApiRoute got both machines and reads — keep machines (reads is its old name)`. The three definitions keep their `reads` field and gain `machines` holding the same array. Everything downstream (`http.ts`, `api-route.ts`, `query-route.ts`, `render.ts`, `sse.ts`, `inspect.ts`) keeps reading `.reads` and is not edited.

That last point is deliberate. The cacheability proof is `route.reads.some((def) => def.lifecycle === 'session')` in `http.ts` and `query-route.ts`; the event gate loads `[...route.reads, originDef]` in `http.ts`. Four larger features are in flight in those files. An alias release that leaves them alone collides with none of them. The internal rename is one mechanical commit at 4.0.

**The compiler.** In `compiler/compile.ts`, `processFrontmatter` accepts `Stator.machines(...)` and `Stator.reads(...)` and lowers both the same way. A fence that uses both is a `CompileError` at the second call. `emitRoute` emits `machines: [...]`, so compiled routes never trip the deprecation warning themselves. The three messages that say `Stator.reads` change to `Stator.machines`. `ROUTE_ONLY_MARKERS` in `compiler/lower.ts` gains `'machines'`. `COMPILED_CONTRACT` does not move: it covers what compiled components import from `/template` and `/client`, and routes are not shipped by libraries.

**The engine.** `DefineMachineConfig` (`engine/define-machine.ts`) gains `peers?: TReads` and keeps `reads?: TReads`, deprecated. Both set throws at definition. `MachineDef` gains `peers`, the same array as `reads`. `ActionHelpers` (`engine/types.ts`) becomes `{ peers: R; reads: R }` with `reads` deprecated, and every site that builds the helpers object puts one proxy under both keys:

- `engine/actor.ts`, `throwingHelpers`
- `server/reads-helpers.ts`, `serverReadsResolver` (both branches)
- `server/instance-proxy.ts`, the selector helpers
- `client/use.ts`, the client stub

`CreateActorOptions.resolveHelpers` loosens to return `{ peers } | { reads }`, and the actor mirrors whichever it gets onto both keys, so a test that stubs one key works with a machine that reads the other. `ReadsMap` stays exported; `PeersMap` is added as the name the docs use, and `ReadsMap` becomes a deprecated alias of it.

`MachineDescription` (`engine/describe.ts`) gains `peers` beside `reads`. The `/@stator/inspect` payload and `client/inspector.ts` keep `reads` as the wire key until 4.0; only the visible labels change.

**The editor contract.** `StatorMacros` in `src/editor.ts` gains `machines` with today's `reads` signature, and `reads` gets `@deprecated Renamed Stator.machines. Removed in 4.0.` This is the whole editor change for projects on the new release: the language server types the macros from the project's install (`ambientFor`, `packages/language-server/src/language-plugin.ts`), so the strike-through appears only where `machines` exists.

Bundled-compiler tolerance, checked in both directions:

- *Old extension, new project.* `compile()` at 3.0.3 does not reject an unknown `Stator.*` call in a fence. Run against a route that uses `Stator.machines([Cart])`, it compiles without error. The extension already published therefore shows no false error; types come from the project.
- *New extension, old project.* The bundled compiler lowers `Stator.reads` as before. It must not warn about it: `compileWarnings` is what the language server calls (`packages/language-server/src/diagnostics.ts`), and a deprecation there would fire on a 3.0 project that has no `machines` to move to. So the deprecation warning does not go in `compileWarnings`.

**The `stator check` warning.** `check` already builds a `ts.Program` over the app and the virtual TSX of every `.stator` file (`cli/commands/check.ts`), and the macros in that TSX are typed from the project's `StatorMacros`. One pass over the app's own source files asks the checker for the symbol behind each property name, property access and binding element, and reports it when the symbol carries a `deprecated` JSDoc tag and is declared inside `@statorjs/stator`. Positions in generated files go through the existing `toStatorSource` mapping. This covers `Stator.reads` in a fence, `reads:` in all three definers, and `helpers.reads` however it is destructured, with no pattern matching on the word `reads`, and it will report the next deprecation for free. Output is tsc-shaped, counted in the existing `N warnings` summary, and never fails the check.

**The dev warning.** `defineMachine`, `defineRoute` and `defineApiRoute` record which spelling declared the definition. After discovery, the dev server (`server/dev-native.ts`, beside the `findPollLoops` report) logs one line naming the files: `stator: reads is deprecated (3 files: machines/cart.ts, routes/checkout/submit.ts, …) — machines: on routes, peers: on machines. stator check lists every use.` Once per process. Not in production. `helpers.reads` access is not logged at runtime; the types and `check` cover it.

**Machine hashes.** Two resets follow, and the changeset states both.

1. *Upgrading resets every session machine once, in every app.* The engine hash is an input to every machine's hash, and it is measured over `engine/*` plus the actor host (`ENGINE_HOST`, `server/machine-hash.ts`), which includes `engine/define-machine.ts`, `engine/actor.ts`, `server/reads-helpers.ts` and `server/instance-proxy.ts`. This spec edits all four. `persist: true` app machines follow the same rule and restart from their initial state.
2. *Renaming in a machine's source resets that machine once.* `reads:` → `peers:` and `{ reads }` → `{ peers }` change the bundle the hash is taken over (identifiers are not minified), for that machine and for any machine that imports it. `stator build` already prints the list. Renaming on routes resets nothing; routes are not in any machine's closure.

An app that upgrades and renames in one deploy pays once. So does a release that carries this alongside the other engine-hash change already committed for 3.1 (the `node24` target), which is the reason to put the engine half in that release.

**Packages built on Stator.** A package that ships route handlers or machines (`@indiepub/stator`) runs its `defineApiRoute({ reads })` against the app's Stator. It keeps working through 3.x and shows up in the app's dev warning by file. It can move to the new names only when its peer range starts at the alias release, and must move before 4.0.

**First-party content.** `create-stator` fetches templates from `examples/` on `main` at scaffold time and pins `@statorjs/stator` to `STATOR_RANGE`. Examples renamed on `main` before the alias release is published would scaffold apps that do not compile. The sweep of examples, docs and READMEs is therefore its own PR, merged after the publish, in the same change that bumps `STATOR_RANGE`.

**Codemod.** A script is needed for the repo itself: 25 `Stator.reads` calls and 22 `reads:` options across the ten examples and `apps/store`, 57 fixture files under `packages/stator/tests/fixtures`, and 55 lines of docs. `scripts/rename-reads.mjs` does it with the TypeScript API: the two property renames are syntactic, and `{ reads }` in a helper position is renamed with the language service so every use in the body follows. It is not shipped as a `stator` command. A typical app has a handful of sites and `stator check` lists each one with a line number.

**4.0 cutover.** Remove `reads` from `StatorMacros`, the three route configs, `DefineMachineConfig`, `ActionHelpers` and `MachineDescription`; remove `ReadsMap`. Rename the internal fields (`RouteDefinition.reads`, `MachineDef.reads`, the inspect payload key) and `server/reads-helpers.ts`, updating `ENGINE_HOST` and `tests/engine-hash.test.ts`. The project's compiler rejects `Stator.reads` with a message naming `Stator.machines`; the extension's bundled compiler keeps lowering it while 3.x is supported, which needs a `compile()` option the CLI sets and the language server does not. Delete the alias tests. Add the row to the upgrade guide.

## Alternatives Considered

- **`machines` everywhere, including the machine option and `helpers.machines`.** One word for "the machines this thing can see", and the helper map is the same type a data handler's `machines` is. Rejected because the two declarations do different jobs: a route's list is what gets loaded for a request, a machine's list orders discovery, pins the machine to the server and feeds the selector re-diff graph. `machines: [Inventory]` inside `defineMachine` also reads as a container, not a dependency.
- **Keep `reads` on machines, rename only routes.** Smaller, and leaves `read()` beside `helpers.reads`, which is half of the confusion.
- **`uses` or `deps` for the machine option.** `uses` collides with the island `use()`; `deps` says nothing about what kind.
- **Rename the internal fields in the alias release.** Cleaner tree, and it edits `http.ts`, `sse.ts`, `query-route.ts`, `api-route.ts` and `render.ts` under four features in flight for no user-visible gain.
- **A deprecation warning in `compileWarnings`.** One place for editor and CLI, and wrong in the editor on any project older than the alias release.
- **Wait for 4.0 and break once.** No alias code, and every app, package and example changes on the same day as everything else in a major.

## Open Questions

- **Hand-built helper stubs fail typecheck.** A test that calls a selector or guard directly with `{ reads: stub }` (`examples/weather/tests/panels.test.ts`) fails once `ActionHelpers` requires `peers`. The starters' tsconfig includes `**/*.ts`, so the tests are in the program `stator check` types, and `stator build` runs `check` first. Runtime is unaffected. Options: accept it and say so in the changeset (recommended; the fix is one word and the codemod makes it); or leave `helpers.reads` alone until 4.0 and rename only the declarations.
- **Is `peers` final?** Recommended yes, provided presence takes a different word.
- **Does `PeersMap` earn a second exported name?** It is one alias. The alternative is documenting `helpers.peers` as typed by something called `ReadsMap` for a whole major.
- **Should the bundled compiler's messages mention both names?** `Use Stator.machines([...])` is wrong advice on a 3.0 project open in a newer extension. A parenthetical (`Stator.reads before 3.x`) costs a few words.

## Implementation Notes

Three PRs. Changesets: minor for the first two, none for the third.

**PR 1, the engine half (`peers`).** Moves the engine hash; ship it in the same release as the `node24` machine-hash target.

- `packages/stator/src/engine/define-machine.ts`, `engine/types.ts`, `engine/actor.ts`, `engine/describe.ts`
- `packages/stator/src/server/reads-helpers.ts`, `server/instance-proxy.ts`, `server/discovery.ts` (messages), `server/machine-store.ts` (one message)
- `packages/stator/src/client/use.ts`, `client/inspector.ts` (labels)
- Tests: a new `tests/reads-aliases.test.ts` and `tests/reads-aliases.test-d.ts` (both spellings, both-set throws, typed `helpers.peers`, `resolveHelpers` mirroring); `tests/engine.test.ts`, `tests/reads-aware-selectors.test.ts`, `tests/describe-machine.test.ts`; `tests/engine-hash.test.ts` should pass unchanged, since no file enters or leaves the measured set.

**PR 2, the route half (`machines`), the deprecation reporting.**

- `packages/stator/src/server/routing.ts`, `server/dev-native.ts`
- `packages/stator/src/compiler/compile.ts`, `compiler/lower.ts`, `compiler/virtual-code.ts` (comments only)
- `packages/stator/src/editor.ts`
- `packages/stator/src/cli/commands/check.ts`
- `packages/language-server/src/diagnostics.ts` (comment), `packages/language-server/tests/diagnostics.test.ts` (asserts the message text), `packages/language-server/tests/language-plugin.test.ts`
- Tests: `tests/compiler-route.test.ts`, `tests/compiler-diagnostics.test.ts`, `tests/compiler-virtual-code.test.ts`, `tests/virtual-code-typecheck.test.ts`, `tests/check.test.ts` (the warning, located in a `.stator` and in a `.ts`), `tests/data-route-reads-typing.test-d.ts`, and the contract fingerprint test unchanged.

**PR 3, the sweep, after publish.** Generated by `scripts/rename-reads.mjs`; regenerate instead of rebasing.

- `examples/*` (all ten) and `apps/store`; `apps/landing` uses the word only as a verb
- `apps/docs/src/content/docs/**` (55 lines outside the changelog; `concepts/reactivity-and-reads.md` keeps its title, it is about `read()`), a deprecations section in the upgrade guide
- `README.md`, `packages/stator/README.md`, the example READMEs
- `packages/stator/tests/fixtures/**` (57 files) and the tests that inline route or machine source
- `editors/vscode/syntaxes/stator.tmLanguage.json` (a comment)
- `packages/create-stator/index.js` (`STATOR_RANGE`)
- `ROADMAP.md`: move the item from "Parked for the next major" to a 4.0 cutover line.

**Ordering with the features in flight.**

- [[defineapiroute-takes-any-http-method]] and the body-size-limit spec both add fields to `DefineApiRouteConfig` and to the object literals in `defineApiRoute`. PR 2 adds a third on adjacent lines. Land those two first; PR 2 is the mechanical one and rebases in minutes.
- Event schemas add an option to `DefineMachineConfig` and move the engine hash. PR 1 touches the same interface. Either order works; one release for both means one reset.
- Presence and per-request locals each add a `Stator.*` macro if they follow the existing pattern: `editor.ts`, `processFrontmatter`, `ROUTE_ONLY_MARKERS`. PR 2 edits the same three places. Small, adjacent, whoever lands second rebases.
- Cached-page session regions change the cacheability proof in `http.ts` and `query-route.ts`. Nothing here touches those files before 4.0.
- PR 3 touches every example route. Land it last, in a quiet window.

## Decision record (2026-11-22, Tony)

- Ships in 3.1 with the deprecations, both halves in the one release.
- The one type-level break (hand-built `{ reads: stub }` helpers in tests) is accepted and stated in the changeset.
- Internal field names (`route.reads`, `def.reads`) stay until 4.0.
- No codemod is shipped; the repo script covers Stator's own tree.
