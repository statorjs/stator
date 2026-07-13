# Releasing

Versions and changelogs are managed by [changesets](https://github.com/changesets/changesets);
publishing is manual (npm 2FA).

## Day to day

Ship a change to a publishable package (`@statorjs/stator`,
`@statorjs/language-server`, `create-stator`)? Add a changeset in the same
commit:

```sh
pnpm changeset        # pick package(s) + bump + summary
```

That writes `.changeset/<name>.md`. Nothing else happens yet — changesets
accumulate on main.

## Cutting a release

1. CI maintains a **"Version Packages" PR** whenever changesets exist on
   main — it applies the bumps, writes per-package `CHANGELOG.md`s, and
   deletes the consumed changesets. Review and merge it.
   (Or run `pnpm version-packages` locally and commit, same effect.)
2. On the versioned main:

   ```sh
   pnpm release       # changeset publish — prompts for your npm OTP,
                      # publishes only versions npm doesn't have, tags each
   git push --follow-tags
   ```

## Notes

- The root `CHANGELOG.md` stays hand-written for release *stories*
  (1.0.0-style narratives); per-package changelogs are generated.
- The editor extension is NOT npm-published — `editors/vscode` is private
  and versioned by hand (`pnpm run publish:vsce` / `publish:ovsx`).
- `create-stator`'s `STATOR_RANGE` const pins what scaffolded apps get —
  bump it when a new framework minor ships.
