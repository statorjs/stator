---
title: 'stator exec: run a script with the app''s loader and config'
status: draft
created: 2026-11-15
updated: 2026-11-15
area: cli
---

## What and Why

Stator's own loader already runs any TypeScript file, including ones inside `node_modules`: `node --import @statorjs/stator/register script.ts` is the same loader `stator start` uses (`tsx` isn't involved in production). Verified 2026-11-15: the IndiePub minimal theme's seed script, which imports `@indiepub/stator/server/*`, runs under it on Node 24 with no `tsx`. Both IndiePub apps that wrote a seed script added `tsx` because they didn't know the loader existed (minimal theme and indiepub.dev, 2026-11-15).

So the gap is smaller than "scripts can't run":

- The loader is undocumented: `guides/production.md` never mentions `@statorjs/stator/register`, and the package README still says production runs under `tsx`.
- Running a script that way doesn't resolve the app's `stator.config.ts` or load its env the way `stator start` does, so a script has to reproduce that by hand.

`stator exec` closes the second gap; the docs close the first.

## Success Criteria

- `guides/production.md` documents `node --import @statorjs/stator/register <script>`, and the README's `tsx` claims are corrected.
- `stator exec <file> [args…]` runs a `.ts`/`.js` script under that loader with the app's `stator.config.ts` resolved and its env loaded the same way `stator start` does.
- `--boot` runs the app's `boot.ts` first and its cleanup on exit, for scripts that need what boot sets up; without it, nothing of the server starts.
- Exit code is the script's; uncaught errors print located stack traces.
- In a built app (`dist/`), `stator exec` only runs scripts that are in the artifact. `scripts/` is left out of `dist/` unless it's listed in `build.include` (`guides/production.md`), so `exec` errors with that hint when the file isn't there, and the docs show adding `scripts` to `build.include` for apps that run maintenance tasks in production.
- Documented in `guides/production.md` with a seed example.

## Constraints

- No new runtime dependency.
- Not a task runner: no script registry, no watching.
