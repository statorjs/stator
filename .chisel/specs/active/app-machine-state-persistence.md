---
title: App-machine state persistence
status: draft
created: 2026-05-21
updated: 2026-05-21
area: persistence
---

## What and Why

Session-lifecycle machines persist through the Store. App-lifecycle machines don't. App-machine state is held in process memory and wiped on restart.

The Store-adapter spec called this out explicitly: app state is conceptually different from session state (shared across sessions, no TTL, restart-fresh is sometimes correct), and bundling them would force every adapter to handle both shapes. That framing is right, but the consequence shows up in real apps. The poll demo is the first place where "the most important shared state in this app vanishes when the server restarts" is a real, visible bug.

The why this needs its own spec: the answer probably isn't "treat app machines like session machines." It's a different storage shape with different semantics. Naming the problem now keeps the eventual solution from being a hack inside the Store adapter.

## Success Criteria

A deployment of any app using app-lifecycle machines can restart without losing the machines' state. The persistence is opt-in per machine (some app machines genuinely should reset on restart, like a cache or a connection pool). The framework provides at least one shipping implementation, in line with how `RedisStore` followed `InMemoryStore` for session state.

## Constraints

- App machines persist as a whole snapshot, not incrementally. They don't have a per-session sharding key. The storage shape is "one blob per app machine name."
- No TTL. App-machine state is process-equivalent persistence, not user-session storage.
- Boot-time hydration. When the server starts and instantiates app machines, persisted snapshots (where present) are loaded before the actor is started.
- Persistence is opt-in. A machine declares `persist: true` (or similar) in its config. Default is the existing in-memory behavior, so adding the primitive doesn't change anyone's existing app.
- Multi-replica gets weird and is out of scope. If two replicas both think they own `PollsMachine`, they'll drift. Spec assumes single-writer for now. Cross-replica coordination is a separate problem with multiple solutions (leader election, CRDT-shaped state, etc.) that don't belong in this spec.

## Approach

(Sketch. Real design happens when we're ready to ship.)

**Store interface extension:**

```ts
interface AppStore {
  loadAppMachine(name: string): Promise<unknown | null>
  saveAppMachine(name: string, snapshot: unknown): Promise<void>
  // deleteAppMachine if we ever need it; deferred
}
```

Likely a sibling of the existing `Store` interface, not a merger. The session Store and the app Store have different access patterns, different TTL semantics, different keying. Keeping them separate keeps each one's contract small.

**`MachineStore.bootAppMachines` extension:**

When instantiating an app machine, look up its name in the AppStore first. If a snapshot exists, hydrate the actor with it. If not, start fresh.

**Write trigger:**

The cleanest path: app machines write their snapshot whenever their state changes. Subscribe to the actor's emit, debounce, persist. Avoids the per-request `persistTouched` pattern (app machines aren't touched per-session-request).

A simpler-but-coarser path: write on a fixed interval (every N seconds). Loses up-to-N-seconds of state on crash. Maybe fine for poll-shape data.

**Implementations:**

- `InMemoryAppStore` (process memory; same restart-wipe as today, exists to make the interface uniform)
- `RedisAppStore` (single key per machine name, JSON snapshot, no TTL)
- File-based for local dev (an `app-state.json` in the working directory)

## Alternatives Considered

- **Reuse the session Store with a synthetic sessionId** (`__app__`). Considered, rejected. Conflates two different storage semantics, forces every Store adapter to special-case the synthetic sid, breaks the session-TTL invariant.
- **Make all machines session-lifecycle.** Considered, rejected. App machines exist as a real architectural concept (one instance per server, shared across all sessions). Forcing them into the session model would either spawn N redundant copies or invent some "primary session" hack.
- **Per-machine custom persistence (let the user write a hook).** Considered. Rejected because the same machine-state shape we already serialize through the Store should be serializable through this layer too. Custom hooks would let users solve persistence ad hoc, but every solution looks the same.

## Open Questions

- Write-debounce strategy. Snapshotting on every emit could be expensive on chatty app machines. A 1-second debounce balances liveness against cost.
- Recovery semantics. If an app-machine snapshot fails to load (corrupt, wrong shape), do we start fresh or refuse to boot? My pick: log loud, start fresh, treat boot-fresh as the safe default.
- Multi-replica. The spec assumes single-writer. Two replicas both running PollsMachine and both writing snapshots will conflict. A real multi-replica story probably involves either pinning PollsMachine to a leader or rethinking app-machine semantics entirely (turn them into a leader-elected service, or into a distributed-state primitive). Out of scope here; flagged.

## Implementation Notes

(Not implemented. The poll demo ships with the existing in-memory app-machine semantics; restart wipes polls. Documented as a known limitation in the demo's README.)
