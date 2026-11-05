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
- Framework fixture test: a fake package with a precompiled island, consumed by a route; manifest, bundle contents (custom element present, machine body absent), route CSS, dev server. Then the test bed: `@indiepub/stator` ships the admin command palette, tonysull.co imports it, the PR check and the deploy prove it.

## Approach

**1. Publish-time self-containment (`stator build:lib`).** The library compile rewrites each machine import in a `.stator.client.ts` to an inline `{ name }` stub, using the same Node import of the def the bundlers' stub plugins use today, at publish time instead of consume time. A published client entry then imports only browser-safe modules: `@statorjs/stator/client`, the package's own client helpers, npm client libraries. `build:lib` proves it with a dry esbuild pass of every client entry (`platform: 'browser'`, bare specifiers external): a reachable `node:` builtin or a module under the package's `machines/` fails the publish with the offending path. Consumers' bundlers then need no knowledge of a package's machines directory.

**2. Discovery by reachability, in build and dev alike.** Islands are found from the routes' import graphs, not by scanning sources. The walk in `build/islands.ts` crosses a bare specifier once, resolving it from the importer with Node resolution the way route CSS does, and continues through relative imports inside that package directory, so a package server component composing package islands is reached too. A reached module is an island when it is `x.stator.ts` with an `x.stator.client.ts` beside it. The same walk feeds the dev server's island set. `node_modules` is still never compiled.

**3. Stable identity.** A package island's `rel` is its bare specifier (`@acme/blocks/x.stator`), sanitised for the bundle entry name and used verbatim as the manifest key. Islands reached inside a package through relative imports take the specifier of the entry that reached them plus the relative path.

**4. Bundling.** The esbuild bundler takes `x.stator.client.ts` entries under `node_modules` as plain TS. `splitting` dedupes the client runtime across app and package islands by real path; under pnpm the package's `@statorjs/stator` peer resolves to the app's instance, so there is one. Asset `new URL(…, import.meta.url)` rewriting applies unchanged. Library islands require `STATOR_ISLAND_BUNDLER=esbuild` until the default flips; the Vite bundler is not taught any of this.

**5. CSS.** Unchanged: per-component subpath or barrel aggregate through the `exports` map, as the guide documents. A package whose islands are reached only through its own server components ships their CSS in the barrel aggregate.

**6. Dev.** The native dev server bundles package islands through the same seam. Rebuild on change only for a workspace-linked package, by watching the resolved real path when it lies outside `node_modules`; an installed package is immutable for the process.

**7. Custom element names** are the package's responsibility and should carry a package prefix. A collision is the same `customElements.define` error as today.

## Alternatives Considered

- **Scaffold-copy islands into the app** (shadcn mode). The fallback the route-injection spec named; it works today and remains the escape hatch, but every site then forks the admin's client code and upgrades become diffs.
- **Stub package machines at consume time** by teaching the bundlers to recognise a package's `machines/` directory. Needs a convention consumers must know about and leaves server code reachable from a published artifact. Publish-time stubs make the artifact honest on its own.
- **Extend the Vite bundler too.** Doubles the work on the implementation the exit is removing, for the one case Vite handles worst.
- **A manifest shipped by the package listing its islands.** Discovery by reachability needs no manifest, and a manifest would drift from the exports map.

## Open Questions

- **Flip the island bundler default to esbuild with this?** Spike 1 was a provisional GO; the remaining exit gates are worker-WASM islands and Tailwind-over-globs, neither of which tonysull.co uses. The test bed can run under the env var first; flipping the default is its own decision, and this spec is the forcing function for it.
- **Packaging layout for `@indiepub/stator`.** It builds with tsup to `dist/*.js`; islands and server components ship as raw compiled `.stator.ts` siblings under `src/` with `exports` subpaths, as the guide's convention and the framework's own raw-TS packaging. Settle before the first publish.
- **Workspace-linked dev watching** is a convenience; ship without it if the test bed does not need it.

## Implementation Notes

- Build: `build/compile-library.ts` (machine-import rewrite in client entries, browser-safety dry pass), `build/islands.ts` (bare-specifier hop in `localImports`/`walkImports`, island detection by sibling, specifier-based rel), `build/build.ts` (islands from reachability rather than the source compile pass), `build/islands-esbuild.ts` (entries under `node_modules`; nothing expected to change).
- Dev: `server/dev-native.ts` island set from the same walk.
- Docs: component-libraries guide loses the "Islands stay in the app" limit and gains the publish-time rules; the CLI reference for `build:lib`.
- Tests: fixture package with a precompiled island; build and dev-native cases; a `build:lib` failure case for a client entry that reaches a server module.
- Test bed, in order: `@indiepub/stator` ships `admin/command-palette.stator` (reached by every admin route, small, no heavy client deps), tonysull.co swaps its copy for the import, deploy; then `rich-editor` over `@indiepub/editor` as the heavy case.
- Related: [[no-route-injection-package-handlers-mount-files-and-the-layered-indiepub-shape]], [[toolchain-adapter-seam-and-the-vite-exit]], [[client-machine-lifecycle-page-shareable-island-machines]].
