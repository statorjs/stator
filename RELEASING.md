# Releasing

Versions and changelogs are managed by [changesets](https://github.com/changesets/changesets);
publishing is manual (npm 2FA; marketplace PATs). Release-relevant changes
go through **pull requests**, where two gates enforce that nothing ships
undocumented.

## Day to day

Change a published package? Add a changeset in the same PR:

```sh
pnpm changeset        # pick package(s) + bump + summary
```

That writes `.changeset/<name>.md`. Changesets accumulate on `main`; the
version bumps happen later, in the Version PR.

### The two gates (on every PR)

- **Require changeset** — a PR touching `@statorjs/stator`,
  `@statorjs/language-server`, or `create-stator` source must include a
  changeset naming that package. Fires on any source change.
- **Extension bundle gate** — a PR is blocked if it changes what the VS Code
  extension actually *ships* (its compiled bundle, built at the PR base vs
  head) without a `stator-vscode` changeset. It compares the built output,
  not the touched files — so comment-only or tree-shaken-away changes in the
  compiler/language-server don't nag you, and a real behavioral change can't
  reach the marketplace undocumented. This is why you no longer hand-edit
  `editors/vscode/package.json` — a changeset drives the bump.

## Cutting a release

1. CI maintains a **"Version Packages" PR** whenever changesets exist on
   `main` — it applies the bumps, writes per-package `CHANGELOG.md`s, and
   deletes the consumed changesets. Review and merge it. **Do not** run the
   version step by hand (it's the automation's job — keep the PR flow honest).

2. Publish, per target — both manual, both after the Version PR merges:

   ```sh
   # npm packages (@statorjs/stator, language-server, create-stator):
   pnpm release              # changeset publish — OTP; skips private pkgs
   git push --follow-tags

   # VS Code extension — ONLY if the Version PR bumped `stator-vscode`
   # (its name appears in the PR body / its CHANGELOG got an entry):
   cd editors/vscode
   pnpm run publish:vsce     # Azure PAT
   pnpm run publish:ovsx     # OVSX_PAT
   ```

   The extension is `private: true`, so `changeset publish` skips it — but
   changesets still versioned it and wrote its changelog. The only manual
   part is the marketplace push, exactly mirroring the npm OTP step.

## How the extension fits changesets

`.changeset/config.json` sets `privatePackages.version: true` so the private
extension rides the normal Version-PR flow (bump + changelog), and lists
every *other* private package (apps, examples) in `ignore` so they aren't
versioned. `scripts/check-ignore-list.mjs` asserts that list stays complete
in CI — add a new example, and a missing `ignore` entry fails the build.

The extension declares **no** workspace dependency on the language-server
(it bundles the source at build time), so a framework change never
*cascades* into an extension bump — only a real bundle change (caught by the
gate) does.

## Notes

- The root `CHANGELOG.md` stays hand-written for release *stories*
  (1.0.0-style narratives); per-package changelogs are generated.
- `create-stator`'s `STATOR_RANGE` const pins what scaffolded apps get —
  bump it when a new framework minor ships.
- Branch protection on `main` requires the gate checks to pass before merge
  (repo Settings → Branches).
