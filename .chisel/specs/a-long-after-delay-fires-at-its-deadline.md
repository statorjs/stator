---
title: 'A long after delay fires at its deadline'
status: ready
created: 2026-11-27
updated: 2026-11-27
area: server
---

## What and Why

An `after` delay longer than 2^31-1 ms (2,147,483,647 ms, about 24.8 days) fires after 1 ms. `armAfterTimers` (`packages/stator/src/server/timers.ts`) passes the delay straight to `setTimeout`, and Node clamps any larger value to 1 ms with a `TimeoutOverflowWarning` on stderr. So `trial: { after: [{ delay: 30 * DAY, send: { type: 'EXPIRE' } }] }` expires the trial at once.

The restore path has the same defect. When a hydrating runtime or a booting app machine restores a state, the delay is credited with time already served (`Math.max(declared - (Date.now() - enteredAt), 40)`), and a remainder over the maximum is clamped the same way.

Found in review 2026-11 (03-F1) and reproduced on main on 2026-11-27: a 30-day trial was `['expired']` after 150 ms.

## Success Criteria

- An `after` delay over the maximum does not fire before its deadline, and fires once at it.
- Leaving the state cancels the timer at any point, including after the first step has elapsed and the second is pending.
- A restored remainder over the maximum behaves the same: it fires at `enteredAt + delay`.
- Delays at or under the maximum make exactly the `setTimeout` call they made before.

## Constraints

- Patch release. No API change.
- No edit to the engine or to the engine-hash host files. The change stays inside `server/timers.ts`.

## Approach

`server/timers.ts` gets a private `setLongTimeout(fn, delay)` that returns a `LongTimer` (`{ handle }`), and the registry stores those instead of raw handles.

- A delay at or under `MAX_TIMEOUT_MS` (exported, `2 ** 31 - 1`) is one `setTimeout`, as before.
- A longer delay records `deadline = Date.now() + delay` and waits in steps. Each step reads the clock again and waits `min(deadline - now, MAX_TIMEOUT_MS)`, so a step that runs late does not push the fire later.
- `handle` always points at the pending step, so `cancelAfterTimers` clears whichever step is ticking. Every step is unref'd, as the single timer was.
- `armAfterTimers` calls `setLongTimeout` for both the entry delay and the restored remainder.

Docs: no page states a maximum for `after` (`reference/machine.md`, `guides/effects.md`), so nothing becomes wrong.

## Alternatives Considered

- **Reject delays over the maximum.** Day-scale `after` (trial expiry, holds, cache TTLs) is a reasonable use the docs invite, so it should work rather than error.
- **Count the remaining time down without the clock.** Simpler, but each late step adds its lateness to the fire time.

## Open Questions

- A dynamic `delay(ctx)` that returns `NaN`, or a negative number, still fires after about 1 ms, as `setTimeout` does. The review suggests rejecting those with an error naming the machine and state. Not part of this patch.
- Shutdown does not clear armed timers (they are unref'd); that is 03-F10, not this patch.
- Other `setTimeout` calls in `src/server/` take operator configuration, not machine durations: `images.ts` (`encodeTimeoutMs`), `shutdown.ts` (`STATOR_SHUTDOWN_TIMEOUT_MS`), `sse.ts` (`STATOR_SSE_WRITE_TIMEOUT_MS`), `dev-native.ts`. A value over 24.8 days there would be clamped too; left alone.
- The client has no `after` timers: `after` runs only on the server.

## Implementation Notes

One PR, S.

- `packages/stator/src/server/timers.ts`: `MAX_TIMEOUT_MS`, `LongTimer`, `setLongTimeout`, `clearLongTimeout`; the registry and `cancelAfterTimers` use them.
- `packages/stator/tests/after-long-delays.test.ts`: `mock.timers` (which emulates Node's clamp), an app machine with a 30-day `after`: no fire at 5 ms or 1 ms before the deadline, one fire at it, nothing after; cancel after the first step; cancel before it; a restart two days in whose 28-day remainder fires on time.
- Changeset, patch.
