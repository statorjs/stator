---
title: 'A failed app settle write is logged, not fatal'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: server
---

## What and Why

When an app machine's entry effect finishes, `runAppEffect` (`packages/stator/src/server/effects.ts`) settles the resident actor's pendingEntry marker and, for a `persist: true` machine, awaits `store.persistAppMachine`. That await sits in a `try` with a `finally` and no `catch`, and `runAppEffect` is called as `void runAppEffect(...)` from `wireAppEffects`. So an app store whose write rejects (Redis down for a moment, `RedisAppStore` reconnecting) produces an unhandled rejection, and Node's default for that is to end the process. Every other await in the function is caught.

Who hits it: any `persist: true` app machine with an entry effect, whether or not the effect returns a completion. It can happen at boot (`bootAppMachines`) or any time a machine enters a state with an entry effect.

Found in review 2026-11 (03-F2) and reproduced on main on 2026-11-27: a throwing `saveAppMachine` produced an unhandled rejection `Error: redis down`.

## Success Criteria

- A rejected settle write is logged at error level on the `effect` scope with the machine, the effect id and the cause, and the process keeps running.
- The effect's completion, if any, is still dispatched.
- Later effects on the same machine run.
- No change when the write succeeds.

## Constraints

- Patch release. No API change.
- No edit to the engine or to the engine-hash host files (`app-store.ts`, `session.ts`, and the rest). The change stays inside `server/effects.ts`.

## Approach

Wrap the settle persist in its own `try`/`catch` that logs `'entry-effect settle persist failed'` with `{ machine, effectId, err }`, then fall through to the completion dispatch as before.

**State after a failed persist.** The resident actor stays settled. It is the live state, and the effect did finish; there is no engine call to un-settle a marker, and re-invoking the effect in-process would run its work twice. The store keeps the old snapshot with the pending marker until this machine's next successful persist, which the completion dispatch normally is. If no later write succeeds before a restart, the entry effect re-invokes at the next boot, which is the documented at-most-once, non-durable behaviour.

This matches the session path. `runSessionEffect` catches a failed null-completion settle (`'entry-effect settle failed'`) and a failed completion re-entry (`'effect completion dispatch failed'`) and logs both. A session runtime is transient, so after a failed write the store is the only state, and the marker stays pending until a later write or hydration re-invokes it. Neither path rolls anything back.

## Alternatives Considered

- **Skip the completion when the settle write fails.** That is what main did before crashing. The completion is independent of the write, and its own dispatch persists the settled snapshot, so delivering it is the quickest repair of the store.
- **A process-wide `unhandledRejection` handler.** Hides every future bug of this shape rather than fixing this one, and it is the app's choice, not the framework's.

## Open Questions

- After a failed write, the two planes differ in where the truth is. For an app machine the in-memory actor has moved on and the store is behind; for a session machine the in-memory runtime is discarded and the store is the truth. `dispatchToApp` has the same split on any failed persist (the actor has already committed the event). This patch does not change that; it is closer to 03-F14 (partial commits).

## Implementation Notes

One PR, S.

- `packages/stator/src/server/effects.ts`: the `try`/`catch` around `persistAppMachine` in `runAppEffect`.
- Checked for other `void someAsync()` calls with no catch in `effects.ts` and `timers.ts`: `void runAppEffect` (this fix; nothing else in it can reject now), `void runSessionEffect` in `scheduleSessionEffects` (every await inside is caught, including the claims read), and `void fire.catch(...)` in `armAfterTimers` (already caught). No other change needed.
- `packages/stator/tests/app-effect-store-failure.test.ts`: an app store whose settle write rejects. Asserts no unhandled rejection, one error line with the machine and cause, the completion delivered and the store left settled in `ready`, and a later effect running.
- Changeset, patch.
