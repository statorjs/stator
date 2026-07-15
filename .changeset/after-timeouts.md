---
"@statorjs/stator": minor
---

State timeouts (`after`). A state can now declare `after: [{ delay, send }]` — after `delay` ms in the state, the host dispatches `send`. Timers are armed on entry and cancelled on exit; `delay` may depend on context. This is the companion to entry effects: an `after` on a `loading` state rescues a load whose entry effect never completes (a hung fetch, a dropped completion), moving the machine to `error` instead of stranding it.

Because session runtimes are transient, the timers live in a process-wide, in-memory registry (non-durable in v1, like effects — a restart drops armed timers) and fire across or between requests. On elapse the event re-enters through the full session path (lock, hydrate, process, persist, fan out to live pages), and is guard-dropped if the state has already moved on. The same re-entry now also schedules an entry/transition effect that an effect *completion* chains into — previously such a chained effect was dropped.
