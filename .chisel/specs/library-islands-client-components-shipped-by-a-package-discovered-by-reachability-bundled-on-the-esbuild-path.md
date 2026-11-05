---
title: 'Library islands: client components shipped by a package, discovered by reachability, bundled on the esbuild path'
status: draft
created: 2026-11-04
updated: 2026-11-04
area: tooling
---

## What and Why

A component library can ship server components today (`stator build:lib` compiles each `.stator` to its `.stator.ts` shell plus a `.stator.css` sibling, and consumers fold the CSS in through the `exports` map), but not islands. The guide's own limit: "Island discovery walks the app tree only, so a library can't ship a client component yet." `build:lib` already compiles an island's client half to `x.stator.client.ts` and then prints that a consuming app can't discover it. This spec closes that gap, which the no-route-injection spec named as its real successor question: whether a package can ship `.stator` decides whether IndiePub's admin becomes five-line compositions or a shadcn-style copy into every site.

The forcing function is IndiePub extraction phase 4. tonysull.co runs seven islands under its own `templates/` (admin command palette, compose brain, rich editor over `@indiepub/editor`, photo drop and picker, app bar, lite video). The admin ones are IndiePub's, not the site's, and belong in `@indiepub/stator`. The test bed is that package and that site, on the esbuild bundler, before anything lands in the monorepo's examples.

Why this is also a Vite-exit question. Both island bundlers exist on `main` behind `STATOR_ISLAND_BUNDLER` (`vite` default, `esbuild` the Spike 1 candidate with a provisional GO). Library islands exercise the half of a bundler Vite has been awkward at for Stator: client code resolved out of `node_modules` sharing one runtime instance with the app (2.13 had to widen `ssr.noExternal` for exactly this). esbuild has no pre-bundling step and `splitting` dedupes shared modules by real path, which is what Spike 1 measured. Library islands are built and proven on the esbuild path only; the Vite implementation is not extended.

**This is 3.0 scope (Tony, 2026-11-04).** If the test bed pans out, library islands are the headline of a 3.0 that removes Vite from the dependency tree, makes esbuild the only island bundler, and drops `STATOR_ISLAND_BUNDLER` and `STATOR_VITE_DEV`. On 2.x the env var is the interim switch for the test bed. The breaking changes are the removals.

## Where it breaks today, precisely

- **Discovery.** `build/build.ts` finds islands by compiling the `.stator` sources it finds under `outDir`, and `server/dev-native.ts` by scanning the app's `.stator` files. A precompiled island in `node_modules` is never seen.
- **Reachability.** `routeIslandMap` and `localImports` in `build/islands.ts` walk relative specifiers only and stop at `baseDir`; a bare specifier such as `@indiepub/stator/admin/palette.stator` is skipped, so no route ever records reaching it and no script tag is injected. Route CSS (`build/route-css.ts`) already crosses that boundary once, by resolving `${specifier}.css` through the package's `exports` map.
- **Machine stubs.** Both bundlers stub imports to `{ name }` only for modules under the app's `machinesDir`. A package island importing its own machine (`../machines/owner.ts` inside the package) is not stubbed, so the server machine, and through it `node:sqlite`, would be bundled into the browser.
- **Identity.** An island's `rel` is app-relative and names its bundle entry and manifest key; a package island has no app-relative path.

What already works and needs no change: dispatch addresses machines by `name` over the wire, and the layered shape re-exports package machines through the app's `machines/` under the same def, so a package island dispatching to `OwnerMachine` reaches the app's instance. Compiled `.stator.ts` modules carry their prop signature, so typecheck and the editor see library islands as they see library server components. Head injection reads the manifest's route → script URLs and does not care where an island came from.

## Success Criteria

- A route importing `@acme/blocks/x.stator` from `node_modules`, directly or through a package server component, gets that island's script tag in production and in `stator dev`, with the island bundled, its CSS in the route stylesheet, and its custom element upgrading.
- The browser bundle of a package island contains no server code: a published `x.stator.client.ts` reaches only browser-safe modules, and `stator build:lib` fails when it does not.
- One copy of the client runtime in the page when the app and a package both ship islands.
- No bundler configuration in the consuming app, and nothing new in `stator.config.ts`.
- Two components from different packages, or a package and the app, that define the same custom element tag fail `stator build` and `stator dev` with both source paths named, before any page can hit the registry error.
- Two packages that each ship a `src/palette.stator` get different CSS scope ids, so neither's scoped rules apply to the other's markup.
- Every published component ships its compiled siblings and its `.stator` source, with a stamp naming the compiler that produced the siblings; a consumer whose compiler does not match refuses to build, naming the package, and never compiles the shipped source itself.
- Framework fixture test: a fake package with a precompiled island, consumed by a route; manifest, bundle contents (custom element present, machine body absent), route CSS, dev server. Then the test bed: `@indiepub/stator` ships the admin command palette, tonysull.co imports it, the PR check and the deploy prove it.

## Approach

**1. Publish-time self-containment (`stator build:lib`).** The library compile rewrites each machine import in a `.stator.client.ts` to an inline `{ name }` stub, using the same Node import of the def the bundlers' stub plugins use today, at publish time instead of consume time. A published client entry then imports only browser-safe modules: `@statorjs/stator/client`, the package's own client helpers, npm client libraries. `build:lib` proves it with a dry esbuild pass of every client entry (`platform: 'browser'`, bare specifiers external): a reachable `node:` builtin or a module under the package's `machines/` fails the publish with the offending path. Consumers' bundlers then need no knowledge of a package's machines directory.

**2. Discovery by reachability, in build and dev alike.** Islands are found from the routes' import graphs, not by scanning sources. The walk in `build/islands.ts` crosses a bare specifier once, resolving it from the importer with Node resolution the way route CSS does, and continues through relative imports inside that package directory, so a package server component composing package islands is reached too. A reached module is an island when it is `x.stator.ts` with an `x.stator.client.ts` beside it. The same walk feeds the dev server's island set. `node_modules` is still never compiled.

**3. Stable identity.** A package island's `rel` is its bare specifier (`@acme/blocks/x.stator`), sanitised for the bundle entry name and used verbatim as the manifest key. Islands reached inside a package through relative imports take the specifier of the entry that reached them plus the relative path.

**4. Bundling.** The esbuild bundler takes `x.stator.client.ts` entries under `node_modules` as plain TS. `splitting` dedupes the client runtime across app and package islands by real path; under pnpm the package's `@statorjs/stator` peer resolves to the app's instance, so there is one. Asset `new URL(…, import.meta.url)` rewriting applies unchanged. On 2.x library islands require `STATOR_ISLAND_BUNDLER=esbuild`; 3.0 removes the switch with Vite. The Vite bundler is not taught any of this.

**5. CSS.** Unchanged: per-component subpath or barrel aggregate through the `exports` map, as the guide documents. A package whose islands are reached only through its own server components ships their CSS in the barrel aggregate.

**6. Dev.** The native dev server bundles package islands through the same seam. Rebuild on change only for a workspace-linked package, by watching the resolved real path when it lies outside `node_modules`; an installed package is immutable for the process.

**7. Custom element names** are the package's responsibility and should carry a package prefix. A collision is the same `customElements.define` error as today.

## Names across packages

Four namespaces meet when islands come from more than one package. They differ in how much to worry.

- **Custom element tags** are author-declared: `<quantity-stepper>` must match `export class QuantityStepper extends StatorElement` (`compiler/client-script.ts`), never derived from a path. The page's registry is global, so two islands defining one tag means the second `customElements.define` throws and that island never upgrades — today a console error at runtime, on whichever page reaches both. Two mitigations. **Convention:** library tags carry a package prefix (`ip-palette`, not `palette-…`), as every design system does. **Check:** the reachability walk already knows every island shell a route reaches, and each compiled client entry names its tags, so `stator build` and `stator dev` fail when two different sources define one tag, naming both paths. The one unavoidable collision becomes a located error before deploy.
- **CSS scope ids are a standalone bug, found 2026-11-04.** `compile()` hashes `opts.id`, and `compileComponentFile` passes the path relative to the compile root, which for `build:lib` is the library's own root. Two packages that each have `src/palette.stator` compile to the same `data-s-<hash>`, and one library's scoped rules silently apply to the other's elements. This affects server components today, not only islands. **Fix, shipped on its own before this spec:** `build:lib` qualifies the id with the package name from `package.json` (`@indiepub/stator/src/palette.stator`) before hashing. Scope ids live only in markup and CSS, so nothing persisted moves.
- **Bundle entries and manifest keys** are the bare specifier (Approach 3), distinct by construction.
- **Machine names.** Islands dispatch by name to whatever the app registered; discovery already throws on a duplicate machine name in the app's `machines/`. Two packages shipping a machine of one name is a conflict the app author resolves in their re-export, with an error, not a silent override.

## Shipping compiled output and source

**Why compiled output, revisited.** The library spec's reason for compiled siblings was Vite-specific: `node_modules` had to be an opaque boundary because Vite's dependency transforms and `?v=` propagation could fork framework singletons across versions. The exit removes that mechanism. What remains is weaker but real: production has no compiler in the process — `stator start` serves plain TypeScript from `dist` — and dev never compiles `node_modules`, which keeps it fast and simple. Both are worth keeping.

**Drift is a contract whether or not we name it.** A published `x.stator.ts` imports specific helpers from `@statorjs/stator/template` and `/client`, emits a specific island protocol and scope attribute format. The peer range governs the runtime API as for any JavaScript library, but nothing records which compiler produced the output or checks it at consume time, so a library built on an older compiler could render wrongly on a newer runtime and the consumer's build would say nothing about why. The Svelte ecosystem met exactly this at its 4→5 transition, where shipping source made the compiler the compatibility surface.

**Decided (Tony, 2026-11-04): ship both, compile at publish only.**

- **Compiled siblings are the artifact.** Consumers use `x.stator.ts`, `x.stator.client.ts` and `x.stator.css` exactly as today. Prod never compiles, dev never compiles `node_modules`, publish-time machine stubs keep the client entry honest, and the editor reads prop signatures from the `.ts`.
- **`build:lib` stamps a contract.** A per-package record (`stator-lib.json` beside the compiled output, or a field in `package.json`) naming the compiler version and the compiled-shape contract version it targets. `stator build` and `stator check` compare it with the consumer's own; a mismatch **refuses the build**, naming the package and both versions. Drift becomes a located message instead of a wrong page.
- **The `.stator` source ships too**, for the language server (go-to-definition into the real template) and for inspection. **Consumers never compile it.** No recompile-on-mismatch path exists: it would put an unknown into the build process (whose compiler produced what is in `dist`?). A library with no compiled output, or compiled by a compiler the consumer's contract does not accept, is a problem for the library author (republish) or the consumer (pin) to solve, and the build says which.
- Fully shipping source with no `build:lib` step, Svelte-style, is rejected: it makes the template grammar the compatibility surface, moves compile cost and island stubbing to every consumer, and gives up the already-resolved boundary. The grammar is the part of Stator most likely to keep evolving; the compiled shape is the contract semver can govern.

## Alternatives Considered

- **Scaffold-copy islands into the app** (shadcn mode). The fallback the route-injection spec named; it works today and remains the escape hatch, but every site then forks the admin's client code and upgrades become diffs.
- **Stub package machines at consume time** by teaching the bundlers to recognise a package's `machines/` directory. Needs a convention consumers must know about and leaves server code reachable from a published artifact. Publish-time stubs make the artifact honest on its own.
- **Extend the Vite bundler too.** Doubles the work on the implementation the exit is removing, for the one case Vite handles worst.
- **A manifest shipped by the package listing its islands.** Discovery by reachability needs no manifest, and a manifest would drift from the exports map.
- **Recompile a library's shipped `.stator` source at consume time when its contract stamp mismatches.** Rejected (Tony, 2026-11-04): it creates unknowns in the process — `dist` would hold output from two compilers with nothing recording which. A mismatch is an error for the author or consumer to resolve.

## Open Questions

- ~~**Flip the island bundler default to esbuild with this?**~~ **Resolved 2026-11-04:** 3.0 removes Vite and the switch; esbuild is the only bundler. The remaining exit gates (worker-WASM islands, Tailwind-over-globs) are closed by evidence from the test bed, which runs under the env var on 2.x.
- **Where the contract stamp lives** — `stator-lib.json` beside the compiled output, or a `stator` field in `package.json`. Lean: the sidecar file, written by `build:lib`, so `package.json` stays the author's.
- **Contract version numbering** — one integer for the compiled shape, bumped deliberately when the emitted shell/client/scope format changes, independent of the package version, so a 2.x compiler change that leaves the shape alone does not refuse older libraries.
- **Packaging layout for `@indiepub/stator`.** It builds with tsup to `dist/*.js`; islands and server components ship as raw compiled `.stator.ts` siblings under `src/` with `exports` subpaths, as the guide's convention and the framework's own raw-TS packaging. Settle before the first publish.
- **Workspace-linked dev watching** is a convenience; ship without it if the test bed does not need it.

## Implementation Notes

- **First, standalone:** `build/compile-library.ts` passes a package-qualified id into `compile()` so scope hashes differ across packages; test with two fixture packages sharing a relative path. Own PR, own changeset, before anything below.
- Build: `build/compile-library.ts` (machine-import rewrite in client entries, browser-safety dry pass, contract stamp), `build/islands.ts` (bare-specifier hop in `localImports`/`walkImports`, island detection by sibling, specifier-based rel, tag-collision check from the reached client entries), `build/build.ts` (islands from reachability rather than the source compile pass; contract-stamp check against reached packages), `build/islands-esbuild.ts` (entries under `node_modules`; nothing expected to change), `cli/commands/check.ts` (the same stamp check).
- Dev: `server/dev-native.ts` island set from the same walk.
- Docs: component-libraries guide loses the "Islands stay in the app" limit and gains the publish-time rules; the CLI reference for `build:lib`.
- Tests: fixture package with a precompiled island; build and dev-native cases; a `build:lib` failure case for a client entry that reaches a server module; two packages defining one tag → build fails naming both; a package stamped with a different contract version → build refuses naming it; two packages with the same relative component path → distinct scope ids.
- Test bed, in order: `@indiepub/stator` ships `admin/command-palette.stator` (reached by every admin route, small, no heavy client deps), tonysull.co swaps its copy for the import, deploy; then `rich-editor` over `@indiepub/editor` as the heavy case.
- Related: [[no-route-injection-package-handlers-mount-files-and-the-layered-indiepub-shape]], [[toolchain-adapter-seam-and-the-vite-exit]], [[client-machine-lifecycle-page-shareable-island-machines]].
