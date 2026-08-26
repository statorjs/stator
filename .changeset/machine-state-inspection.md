---
"@statorjs/stator": minor
---

The dev inspector now inspects machines, not just wire traffic. The toolbar gets a **Machines** tab: every machine's current state and context — your own session's, plus app-lifecycle machines labeled as the process-global state they are — the events its current state accepts (server-only and guarded ones marked), and the route table with each route's `reads`. When a persisted snapshot was written by different machine code, the card says so: a `stale` chip shows the session will start fresh on its next request, which is the snapshot hydration policy made visible instead of inferred from logs.

Behind the tab are two additive pieces of public surface. `describeMachine(def)` (exported via `@statorjs/stator/machine`) serializes a machine def to plain JSON-able data — states, per-event transition candidates (`to`/guard/action/emits/effect), entry effects and `after` timers, machine-level fallbacks, `serverOnly`, emits, selectors, reads, subscribes — with closures reported as presence, never bodies. And `GET /@stator/inspect` serves the catalog plus snapshots, scoped to the caller's own session cookie by construction.

The endpoint is served by the dev servers only. Production never registers it — including when a site opts into the wire toolbar with `dev.inspector: true` — because machine context is working state and may hold anything; the tab degrades to a notice there. The endpoint is read-only: no actors are instantiated, no session lock is taken, nothing dispatches. A session machine you've never touched reads as `null` and the tab shows the def's initial context, dimmed — truthfully "what a fresh instance would start from," not fake state.
