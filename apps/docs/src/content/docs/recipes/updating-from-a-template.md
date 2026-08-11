---
title: 'Updating from a template'
description: 'How to pull template improvements into an app you scaffolded with create-stator, using plain git.'
sidebar:
  order: 4
---

An app scaffolded with `create-stator` is a snapshot, not a fork. You own the code, and there is no automatic upgrade channel for it — that is deliberate. The framework itself updates the normal way, through `@statorjs/stator` releases, and your app diverges from its template the moment you start building. Treat template updates as an occasional convenience for early-stage apps, not something to track.

That said, when a template fix lands that you want — a rendering bug, a CSS improvement — git can deliver it cleanly. Both recipes below work even though your app shares no git history with the Stator repository.

## Find your base

Every update needs to know which template version you started from.

Apps scaffolded with a recent `create-stator` carry it in `package.json`:

```json
"stator": {
  "template": {
    "source": "gh:statorjs/stator/examples/weather",
    "commit": "9f31c2ab…"
  }
}
```

Older apps can use the release tag closest to when they were scaffolded — tags look like `@statorjs/stator@2.0.0` in the Stator repository.

## Recipe 1: cherry-pick with a subtree shift

Best when your app is a git repository and you want specific upstream commits, conflict handling included.

```bash
git remote add stator https://github.com/statorjs/stator
git fetch stator main
git cherry-pick -Xsubtree=examples/weather <commit>
```

The `-Xsubtree` option shifts the incoming paths so `examples/weather/static/app.css` applies to your `static/app.css`. Files you never modified update silently. Files you changed get normal conflict markers to resolve with the usual `git cherry-pick --continue` flow.

Replace `examples/weather` with your template's directory throughout — it is recorded in `stator.template.source`.

## Recipe 2: apply a patch

Best for a one-off update without adding a remote. From a clone of the Stator repository:

```bash
git diff <base>..<new> -- examples/weather > update.patch
```

Then in your app:

```bash
git apply -p3 update.patch
```

The `-p3` strips the `examples/weather/` prefix. Add `--reject` to turn conflicting hunks into `.rej` files you resolve by hand.

## What to watch for

- **Skip `package.json`.** Scaffolding rewrites the app name and the `@statorjs/stator` version, so the template's copy will conflict with yours. Exclude it from the patch (`':(exclude)examples/weather/package.json'`) or take your side (`git checkout --ours package.json`) and port any dependency changes by hand.
- **Cherry-picks want template-scoped commits.** The subtree shift aligns whole trees, so pick commits that only touch the template's directory. For mixed commits, use the patch recipe with the `-- examples/weather` path filter instead.
- **Generated files regenerate.** `.stator/` and `stator-env.d.ts` come from `sync`, so they never need updating from upstream.
- **Files you deleted conflict as modify/delete.** Removing template extras (the design notes, FINDINGS) is normal — an update that touches them surfaces as a `deleted by us` conflict. `git rm` the path to keep your deletion and continue.
- **Your lockfile can pin you below what the new template needs.** The framework range in `package.json` (e.g. `^2.0.0`) may already cover the required version while your lockfile stays on the old one — a plain install changes nothing. Run `pnpm update @statorjs/stator` (or your package manager's equivalent) so the update actually lands.
- **Afterwards**, run `typecheck` and a visual pass — a template update is a code change like any other.
