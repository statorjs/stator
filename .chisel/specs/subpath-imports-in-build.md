---
title: 'The build resolves # subpath imports as dev does'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: build
---

## What and Why

An app that uses Node `#` subpath imports (the `imports` field of its `package.json`, for example `import Card from '#components/card.stator'`) works under `stator dev` and breaks under `stator build` and `stator start` (review finding 06-F2, re-confirmed on `main` at 7780195).

- The build rewrites `#…/card.stator` to `#…/card.stator.ts` in `dist/` and then walks each route's imports for its CSS (`routeCssMap`) and islands (`reachIslands`). Both walks ran before `writeArtifactDeps` wrote `dist/package.json`. `resolveBare` sent a `#` specifier through `createRequire`, which found no `package.json` in `dist/` and climbed to the app's own (or none), whose targets name the source `.stator` files. The import was silently dropped, so the route shipped with no scoped CSS from that component and no `<script>` for an island behind it. A build of `tests/fixtures/subpath-imports-app` on `main` gives `routeCss: {}` and `routes: {}`.
- For an app without its own lockfile (a workspace member), the generated `dist/package.json` had no `imports`, so importing `dist/routes/index.ts` failed with `ERR_PACKAGE_IMPORT_NOT_DEFINED`. With a lockfile, the copied manifest's `imports` still named `./components/badge.stator`, a file the build deletes, so an exact key whose target is a `.stator` file failed the same way.
- The copy set (esbuild) already followed `#` imports, but recorded a `#` import mapped to a package (`"#db": "pg"`) as a dependency named `#db`.
- Related (07-F2 (a) and (c)): the dev module graph's `localImports` dropped every non-relative specifier, so editing a file reached only through a `#` import logged a reload and served stale code. Its bound was `target.startsWith(baseDir)` with no separator, so `/app` also matched `/app2`.

## Success Criteria

- A route that reaches a styled component and an island through `#` imports has its `routeCss` entry and its island script in `stator-manifest.json`, and the CSS file holds that component's rules.
- `dist/package.json` carries the app's `imports`, with every key and `./` target ending in `.stator` renamed to `.stator.ts`, and the built route imports and serves under `createApp` (what `stator start` runs).
- A copied manifest is still byte for byte the app's unless its `imports` names a `.stator` path; then only `imports` changes.
- A `#` import in a module the graph reaches that the built app could not resolve fails the build with `file:line` and the specifier, rather than producing a `dist/` that fails at start.
- `localImports` returns the target of a `#` import inside the app root, and not a file in a sibling directory sharing the root's name as a prefix.

## Constraints

- Patch release. No API or config change.
- Files under `packages/stator/src/build/` only. `server/dev-native.ts` is unchanged: it already builds its graph from `localImports`.
- One resolver: `#` resolution reuses the pattern and condition matching `resolveExports` uses for `exports` (`import`, `node`, `default`), not a second implementation.

## Approach

`build/reachability.ts`: `resolveBare` sends a `#` specifier to `resolveSubpathImport`. That finds the importer's package scope (the nearest `package.json`, found with the file system: `findPackageJSON` is cached for the process and would remember `dist/package.json` as missing from before the build wrote it), reads `imports`, and matches the specifier with `mapTarget`, the exact-key-then-longest-pattern matcher `exportsTarget` now shares, and `conditionTarget`. A `./` target is a file in that package, kept in the importer's path spelling (no realpath) so an app module reached by `#` is named as its relative imports name it. Any other target is a package specifier, resolved with `resolveBare` from the package. `subpathImportTarget` exposes the matched target before file resolution.

`build/artifact.ts`: `distImports` renames `.stator` keys and `./` targets (string leaves of conditional and array targets included) to `.stator.ts`, matching the build's specifier rewrite. The generated manifest carries `imports: distImports(app.imports)`. The copied manifest is rewritten in that field only when it changes.

`build/build.ts`: `writeArtifactDeps` runs after compiling and rewriting, before the route CSS and island walks, so those walks resolve `#` imports through the artifact's own manifest as the runtime will. `checkSubpathImports` then reads every built module the copy set reached and fails the build for a `#` import (type-only ones excepted) whose key matches nothing in `dist/package.json`, or whose `./` target does not exist in `dist/`. A target naming a package is left to the install. A compiled `.stator` is named by its source path without a line, since its lines are the compiler's.

`build/copy-set.ts`: a `#` import resolved into a package records the package its target names.

`build/islands.ts` (07-F2): `localImports` also resolves `#` specifiers with `resolveSubpathImport`, and bounds targets by `baseDir` plus a separator.

## Supported and refused

- Supported: exact keys (`"#ui/badge.stator": "./components/badge.stator"`), `*` patterns (`"#components/*": "./components/*"`, `"#c/*.stator": "./c/*.stator"`), conditional targets (`import`, `node`, `default`; `require`-only and other conditions are not taken), arrays (first usable entry), and targets naming a package (`"#kit": "@acme/kit"`).
- Refused at build time, located: a `#` import no key of the app root's `imports` matches, a `#` import in an app whose root has no `package.json` (an `imports` map in a `package.json` above the app root does not travel with `dist/`), and a `./` target that is not in the build output.

## Alternatives Considered

- Write `dist/package.json` earlier and leave `resolveBare` on `createRequire`. Rejected: `require` resolution takes `require` conditions, not `import`, and Node's package-scope cache can hold a stale read of a manifest written mid-process.
- Resolve `#` against the source tree and map the result into `dist/`. Workable, but the walks already run over `dist/`, and resolving through the artifact's own manifest tests exactly what `stator start` will use.

## Open Questions

- Custom conditions (`--conditions=development`) are not modelled, as for `exports`.
- An unused value import in a `.ts` file is elided by esbuild before the copy set sees it, while Node's type stripping keeps it. That predates this change and applies to relative imports too; `checkSubpathImports` catches the `#` case.

## Implementation Notes

- Tests: `packages/stator/tests/build-subpath-imports.test.ts` with the fixture `tests/fixtures/subpath-imports-app/` (pattern import of a styled component and an island, a conditional exact import of a styled component), built into `tests/fixtures/.tmp-subpath-imports-dist` and served with `createApp`; refusal cases, copied-manifest rewriting, the copy set's package name, and `localImports`, in temp directories. `tests/reachability.test.ts` covers `resolveBare` for `#` patterns, conditions and package targets.
- Docs: `guides/production.md`, "What gets copied" and the lockfile bullet.
