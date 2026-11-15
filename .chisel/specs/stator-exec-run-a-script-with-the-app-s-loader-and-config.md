---
title: 'stator exec: run a script with the app''s loader and config'
status: draft
created: 2026-11-15
updated: 2026-11-15
area: cli
---

## What and Why

Stator and the packages built on it ship TypeScript source, and production runs under `tsx`. Node won't strip types inside `node_modules`, so a one-off script (seed, import, backfill, a maintenance task) that imports app code or a library like `@indiepub/stator` can't run under plain `node`. Both IndiePub apps that wrote a seed script had to add `tsx` and work out the environment by hand (minimal theme and indiepub.dev, 2026-11-15).

## Success Criteria

- `stator exec <file> [args…]` runs a `.ts`/`.js` script with the same loader `stator start` uses, the app's `stator.config.ts` resolved and its env loaded the same way.
- `--boot` runs the app's `boot.ts` first and its cleanup on exit, for scripts that need what boot sets up; without it, nothing of the server starts.
- Exit code is the script's; uncaught errors print located stack traces.
- Works in a built app (`dist/`) as well as in source, so a Fly machine can run `stator exec scripts/backfill.ts`.
- Documented in `guides/production.md` with a seed example.

## Constraints

- No new runtime dependency beyond what `stator start` already uses.
- Not a task runner: no script registry, no watching.
