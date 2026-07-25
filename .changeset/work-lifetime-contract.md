---
"@statorjs/stator": minor
---

Work-lifetime contract for state-anchored effects and timers. Entry effects are the load role — re-invoked on hydration when a process died mid-flight (same effectId), abortable via meta.signal on state exit. Transition effects are the command role — at-most-once, never re-invoked. `after` timers re-arm on hydration with elapsed credit, so restarts no longer silently kill countdowns. Machine-driven re-entries no longer refresh the session TTL, and out-of-band events for expired sessions are dropped instead of resurrecting fresh machines.
