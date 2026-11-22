---
title: 'Presence: a read over live connections, a debounced watch, and the CRDT boundary'
status: draft
created: 2026-11-22
updated: 2026-11-22
area: runtime
---

## What and Why

Stator has no presence. The SSE registry holds every live connection with its session id, route key, request and runtime (`server/sse.ts`, the module-level `connections` map), and the only thing it exposes is `activeConnectionCount()`. Nothing tells server code *who* is connected to *what*, and nothing tells a machine that someone arrived or left.

Two apps wait on it, and they want different halves:

- **`weather`** (`examples/weather`) wants the server to poll forecasts only for places a connected session is watching, and to stop when the last watcher goes. Today the cadence lives in the browser: `templates/refresh-clock.stator` ticks `REVALIDATE` every 15 minutes while the tab is visible, and `ForecastCache`'s staleness guard does the rest. It needs a **read**: which sessions are connected now, and what does each one watch.
- **`planning-poker`** (planned starter) wants a room page to show who is at the table right now, live, for every viewer. It needs **change**: someone joined, someone left, with two tabs counting as one person and a refresh not flapping.

This spec ships one small object, `presence`, with three methods, handed to `boot.ts`. It adds nothing to `defineMachine` and nothing to templates. Presence reaches a page the way everything else does: boot code dispatches it into an app machine, the machine holds it, a route reads it, fan-out patches it.

The spec also answers a question the project owner asked directly: how far Stator goes toward CRDTs and conflict resolution. The answer is "not far, on purpose", and the section below says exactly where the line is and what sits on each side.

## Success Criteria

- `boot.ts` receives `presence` on its context. `presence.sessions()` answers "which sessions hold a live connection, on which route, with which params" and is derived from the connection registry at the moment of the call.
- `presence.watch()` calls a listener with the full present set whenever that set changes, with a grace period on departure. Opening a second tab does not call it. A page refresh does not call it. A departure calls it once, `graceMs` after the last connection closes.
- `presence.read(sessionId, Machine)` returns that session's current state for one session machine, from the store.
- `planning-poker` shows a live "who's here" list in a room, identical in every viewer's browser, with no session id anywhere in the HTML, the wire patches, or a keyed-list key.
- `weather` loses `refresh-clock.stator`. A `boot.ts` poll fetches only places a connected session has saved, a newly connected session's places are warmed at once, and with no connections the loop makes no upstream request.
- A process restart with a persisted app machine that stored a present set heals on boot without app code: the first `watch` call delivers the true (empty) set.
- No new template binding kind, no new machine config key, no new wire message, no new HTTP endpoint.
- The docs carry one boundary statement about CRDTs that every page on shared state can repeat.

## Constraints

- **Non-breaking minor.** `activeConnectionCount()` stays where it is, Stable, unchanged.
- **Derived, not counted.** "Who is connected" is recomputed from the registry on every read and before every listener call. The only extra state is a short list of recent departures with timestamps, used for the grace period. Losing that list shortens a grace period; it cannot create or keep a ghost.
- **Single process**, like fan-out and app machines today (`guides/realtime-sse.md`, `guides/app-machines.md` "The single-replica caveat"). The API is shaped so the Redis backplane can stand behind it later without a signature change (see Single process and replicas).
- **The session id is the credential.** 3.0 hashes it in logs (`logSid`, `server/logger.ts`). Presence hands raw session ids to server code only, the same trust `sourceSessionId` already has on session-to-app subscriptions. No presence data reaches a browser unless an app selector puts it there.
- **No bind-family growth.** Declarative `clock()`/`source()` primitives stay deferred (ROADMAP). `presence.watch` in `boot.ts` is the userland form of a presence source, which is the pattern `boot.ts` exists for (`BootContext`'s doc comment: "boot is a *source*, not a controller").
- Only `live: true` pages hold a connection, so only they are present. A page without the flag has no presence, by construction.

## Approach

### What the registry already knows (verified)

- A `Connection` carries `sessionId`, `clientId` (the page-load id), `routeKey` (`GET /r/abc?x=1`: the literal path plus query), `request` (with resolved `params`), and the session's `runtime` (`server/sse.ts`).
- `/__sse` always establishes a session (`getOrCreateSessionId`, `server/http.ts` in the `/__sse` handler), even for a page that reads only app machines. Every connection has a real session id; `@anonymous` never appears in the registry.
- `/__sse` runs the route's admission probe before it registers (`refusal(...)`, same handler). A visitor turned away from a page is never present on it.
- One page load holds at most one connection per route: a second with the same `(sessionId, clientId, routeKey)` evicts the first (`registerConnection`).
- The client releases its connection 30 seconds after the tab is hidden and on `pagehide`, and reconnects on return (`client/runtime.ts`, `guides/realtime-sse.md` "Idle pages let go"). So "connected" already means roughly "has the page in front of them or did within 30 seconds".
- `rotateSession` and `clearSession` hang up the old id's connections (`closeSessionConnections`, called from `rotateSessionNow` in `server/session.ts`).
- The connection does **not** carry the route's pattern. `matched.route.urlPath` (`/r/:id`, `server/route-discovery.ts`) is in scope where the connection is registered and has to be stored on it.

### The surface

One new module, `packages/stator/src/server/presence.ts`. Types exported from `@statorjs/stator/server`; the object reaches app code as `BootContext.presence` and `StatorApp.presence` (the same pairing `dispatchToApp` has).

```ts
export interface PresenceEntry {
  /** The session. Server-side only: this is the credential. Never render it,
   *  never use it as a list key. */
  readonly sessionId: string
  /** The route's pattern, as discovery names it: '/r/:id'. */
  readonly route: string
  /** Path params of the page this session has open. */
  readonly params: Readonly<Record<string, string>>
  /** Live connections (tabs) this session holds on this route and params.
   *  0 only inside a watch listener, for an entry in its grace period. */
  readonly connections: number
}

export interface PresenceFilter {
  /** Match one route pattern exactly. Omitted: every live route. */
  route?: string
  /** Match these param values. Omitted keys match anything. */
  params?: Readonly<Record<string, string>>
}

export interface PresenceWatchOptions extends PresenceFilter {
  /** How long a session stays present after its last connection closes.
   *  Default 5000. Capped at 60000. */
  graceMs?: number
}

export interface Presence {
  /** Who is connected right now. One entry per (session, route, params):
   *  two tabs on the same page are one entry with connections: 2. */
  sessions(filter?: PresenceFilter): Promise<PresenceEntry[]>

  /** Call `listener` with the full present set: once at registration, then
   *  whenever the set changes. Arrival is immediate; departure waits graceMs.
   *  Returns a stop function, which is a valid boot teardown. */
  watch(
    options: PresenceWatchOptions,
    listener: (present: PresenceEntry[]) => void | Promise<void>,
  ): () => void

  /** One session machine's current state for one session, read from the
   *  store: the same read proxy a route gets from `Stator.reads`. `undefined`
   *  when the session has no stored state for that machine. */
  read<D extends AnyMachineDef>(sessionId: string, machine: D): Promise<InstanceOf<D> | undefined>
}
```

```ts
export interface BootContext {
  dispatchToApp<D extends AnyMachineDef>(machine: D, event: EventOf<D>): Promise<{ committed: boolean }>
  readonly config: StatorConfigData
  readonly presence: Presence // new
}
```

Decisions in that shape:

- **Identity is the session.** A person across tabs is one session, so entries are deduplicated by `(sessionId, route, params)`. A person across devices is two sessions; that is the deferred user lifecycle (`primitive-gaps.md` item 4) and an app with sign-in can already collapse it, because its app machine learns `sourceSessionId` and its own user id together on the join event.
- **A room is a route pattern plus params.** Nothing is declared. `/r/:id` with `params.id === 'abc'` is the room. The query string is not part of the key (two viewers of the same room with different `?sort=` are in the same room). An app that wants a different grouping (a document id held in session state, as weather's places are) groups the entries itself, using `read`.
- **`watch` delivers state, not edges.** The listener gets the whole present set for its filter, every time. There is no `join` event and no `leave` event to miss, double-count, or replay after a crash. An app that needs edges diffs two sets; the reverse (rebuilding a set from edges) is the thing that drifts.
- **`sessions()` is async** although the 3.x implementation is a synchronous walk of a map. That is the one concession to the backplane: a cross-replica read may be remote, and a `Promise` return is the signature that survives either implementation.
- **`read` goes to the store**, not to the connection's runtime. The connection's actors are a diff baseline, rehydrated by fan-out only for machines the page binds (`fanOut` in `server/sse.ts`), so they can be stale for a machine that is loaded but unbound. The store is the truth, it works for an entry in its grace period (no connection exists), and it works unchanged across replicas because the session store is already shared. Implementation: the read half of `reenterSessionEvent` (`server/effects.ts`): `persistence.get` first and return `undefined` on `null` (the resurrection guard: a read must not start a fresh machine and fire its entry effect), then a throwaway `SessionRuntime`, `loadGraph([def])`, take the proxy, dispose. No lock (GETs take none either), no subscriptions wired, nothing persisted, queued effects discarded.
- **Per-connection metadata is out.** Name, role, "is typing", a chosen card: these are app state. The app writes them into its app machine through ordinary events, keyed by `sourceSessionId`, and joins them to the present set in a selector. The framework carries no metadata bag, so there is no second, weaker state channel to reason about. High-frequency ephemera (live cursors) are a different problem; see the CRDT section.

### How presence reaches the page

Through an app machine, with no new mechanism:

1. `boot.ts` watches a route and dispatches the present set to an app machine with `dispatchToApp`.
2. The machine stores it (session ids, server-side).
3. A selector joins it to what the app knows about each session and returns public data only.
4. A `live` route reads the selector; `fanOut` patches every viewer when the event commits.

A browser cannot forge step 1's event: `/__events` refuses an event addressed to an app machine with a 403 (3.0.3), and the event has no subscription path.

### Semantics of the present set

- A session is present on `(route, params)` from the moment its first connection there registers until `graceMs` after its last one unregisters.
- Refresh: the old connection closes, the new one registers well inside the grace period, the set never changed, the listener is not called.
- A hidden tab leaves 30 seconds after hiding (the client's release) plus `graceMs`. That is the intended meaning of "here".
- `rotateSession`/`clearSession`: the old id leaves **at once**, with no grace. The id is dead and will never reconnect; holding it would show a signed-out person as present.
- Superseded-connection eviction, queue overflow, and write timeout all go through `unregisterConnection`, so they are ordinary departures with grace. The client reconnects and the grace absorbs it.
- A half-open socket (laptop lid, NAT drop) stays registered until a write to it fails or times out. With only 25-second pings in the buffer that can take minutes, bounded by TCP. Presence inherits that lag on silent departures. See Open Questions.

### Implementation sketch

`server/sse.ts` gains `urlPath` on `Connection`, an internal `liveConnections()` iterator, and an internal `onRegistryChange(cb)` hook called at the end of `registerConnection` and `unregisterConnection` (with a flag when the close came from `closeSessionConnections`). `server/http.ts` passes `matched.route.urlPath` when it registers.

`server/presence.ts`:

- `departed`: a `Map` from `(sessionId, route, params)` to `{ entry, at }`, written on unregister when it was that key's last connection, deleted on register, pruned past 60 seconds. Not written on a rotate/clear close.
- `derive(filter, graceMs)`: group `liveConnections()` by key, then add `departed` entries younger than `graceMs` that have no live connection, with `connections: 0`. `sessions(filter)` is `derive(filter, 0)`.
- `watch`: on each registry change, and on a timer set for the next grace expiry that could matter, re-derive and compare a signature of the keys against the last delivered one. If it differs, call the listener. Listener calls for one watcher are serialized, and a change arriving while a call is in flight collapses into one follow-up call with the then-current set. A listener that throws or rejects is logged and does not stop the watch. Timers are `unref`ed.
- Cost: one O(connections) pass per watcher per registry change. Fine at the scale fan-out itself is fine at; an index by route is the lever if it ever shows.

`createPresence(store)` builds the object; `create-app.ts` constructs it next to the bound `dispatchToApp` and passes it to `runBoot`.

### planning-poker

A new starter, `examples/planning-poker`, scaffoldable (`packages/create-stator/index.js` template list).

**Routes**

- `routes/index.stator`: a name field and "Start a room".
- `routes/new.ts`: `POST`. Generates the room id (`crypto.randomUUID()`, shortened; the id in the URL is the only thing gating a room, so it is not `Math.random`), dispatches `CREATE` to `SeatMachine`, returns a `navigate` directive to `/r/<id>`. The live-poll create flow, with the id made in the handler because app-to-session delivery does not exist (`app-to-session-subscriptions-via-inbox`, draft) and the browser needs somewhere to go.
- `routes/r/[id].stator`: `live`. Reads `[RoomsMachine, SeatMachine]`. 404 when the room is unknown. A visitor without a seat sees the table and a join form; with a seat, the cards.

**Machines**

- `SeatMachine` (session): the gateway. Context `{ seats: Record<roomId, { pid, name }> }`, because one session can sit in two rooms in two tabs and a session machine is not keyed by route params. `pid` is a public participant id minted in the handler (`do`), never taken from the event. Events `CREATE` (`serverOnly`), `JOIN`, `VOTE`, `REVEAL`, `NEXT_ROUND`, `SET_ROLE`; each emits, with `pid` and `name` taken from context. It `reads: [RoomsMachine]` for the viewer-relative selectors a page needs: `myCard(roomId)`, `isHost(roomId)`.
- `RoomsMachine` (app, `persist: true`): every room in one context, as live-poll holds every poll.

```ts
type Seat = { pid: string; name: string; role: 'voter' | 'observer'; card: string | null; seatedAt: number }
type Room = {
  id: string
  round: number
  phase: 'voting' | 'revealed'
  seats: Record<string /* sessionId */, Seat>
}
type Ctx = {
  rooms: Record<string, Room>
  /** roomId -> session ids connected now. Replaced whole by PRESENCE. */
  online: Record<string, string[]>
}

type Events =
  | { type: 'CREATE_ROOM'; roomId: string; pid: string; name: string; sourceSessionId: string }
  | { type: 'SEAT'; roomId: string; pid: string; name: string; sourceSessionId: string }
  | { type: 'VOTE'; roomId: string; card: string; sourceSessionId: string }
  | { type: 'REVEAL'; roomId: string; round: number; sourceSessionId: string }
  | { type: 'NEXT_ROUND'; roomId: string; round: number; sourceSessionId: string }
  | { type: 'PRESENCE'; online: Record<string, string[]> }

// in the chart
PRESENCE: { do: (ctx, ev) => { ctx.online = ev.online } },
REVEAL: {
  // The round the sender was looking at. A second click that lost the race
  // names a round that is already over, and is refused.
  when: (ctx, ev) => {
    const room = ctx.rooms[ev.roomId]
    return !!room && room.phase === 'voting' && ev.round === room.round && isHost(ctx, room, ev.sourceSessionId)
  },
  do: (ctx, ev) => { ctx.rooms[ev.roomId]!.phase = 'revealed' },
},

// selectors: public shapes only
table: (ctx) => (roomId: string) => {
  const room = ctx.rooms[roomId]
  if (!room) return []
  const online = new Set(ctx.online[roomId] ?? [])
  return Object.entries(room.seats)
    .sort(([, a], [, b]) => a.seatedAt - b.seatedAt)
    .map(([sid, s]) => ({
      pid: s.pid,
      name: s.name,
      role: s.role,
      here: online.has(sid),
      voted: s.card !== null,
      // The card is not in anyone's HTML until the room reveals.
      card: room.phase === 'revealed' ? s.card : null,
    }))
},
watching: (ctx) => (roomId: string) => {
  const room = ctx.rooms[roomId]
  return (ctx.online[roomId] ?? []).filter((sid) => !room?.seats[sid]).length
},
```

The host is derived, not stored: the longest-seated participant who is `here`. When the host closes the laptop, the next person becomes host on the same patch that greys the host out, and no "host left" transition exists to get wrong.

**boot.ts**

```ts
import { defineBoot } from '@statorjs/stator/server'
import RoomsMachine from './machines/rooms.ts'

export default defineBoot(({ dispatchToApp, presence }) =>
  presence.watch({ route: '/r/:id', graceMs: 5_000 }, (present) => {
    const online: Record<string, string[]> = {}
    for (const { sessionId, params } of present) (online[params.id!] ??= []).push(sessionId)
    return dispatchToApp(RoomsMachine, { type: 'PRESENCE', online })
  }),
)
```

**Template** (in `templates/table.stator`, `rooms` passed as a prop the way live-poll passes `polls`): a keyed `each` over `read(rooms, (r) => r.table(roomId))`, keyed by `pid`. Never by session id.

**What it exercises**: URL-keyed shared state, session-to-app gateways with `sourceSessionId`, viewer-relative reads over shared state, secrecy by selector (unrevealed cards), a guard resolving a two-writer race (`REVEAL`/`NEXT_ROUND` carrying `round`), presence through `watch`, and the restart heal (`online` is persisted with the rest of the context; the first `watch` call after boot replaces it with the truth).

**Paper-cut log plan.** `.chisel/docs/planning-poker-paper-cuts.md`, written while building, against the surface above on a branch. Entries are adjudicated before the presence surface ships. The questions the log is expected to answer:

1. Is the full-set listener the right shape, or did the app immediately write a diff? Was grouping by `params.id` by hand an annoyance or a non-event?
2. Is 5 seconds the right default grace? Measure real refresh and deploy-reload gaps. How bad is the half-open lag in practice (close a laptop, time the grey-out)?
3. Did anything tempt the app to render or key by a session id? Did the `pid` indirection hold?
4. `boot.ts` does not run under `app.fetch` tests (`runBoot` is called from `listen()`). How were presence tests written, and does `StatorApp.presence` plus an exported wiring function suffice?
5. Gaps this app will hit that are *not* presence, logged so they are not solved here: one chart state for many rooms (the instance-machine gap; `per-record-child-machines` spec), no per-room expiry timer (same spec), `online` persisted because context has no transient keys (`primitive-gaps.md` item 8), the room id threaded through every event because a session machine is not keyed by params, and `rotateSession` orphaning a seat keyed by session id.
6. Every viewer of every room recomputes on any room's change, because all rooms share one machine. Measure it; it is evidence for the fan-out grouping lever (`sse-delivery` spec), not a presence problem.
7. Does a refused `REVEAL` need to say why? That is the refusal-reasons feature's evidence, not this one's.

### weather

The second consumer, and the one that needs `sessions` and `read`.

```ts
// examples/weather/lib/poll.ts
export async function pollWatched({ presence, dispatchToApp }: Pick<BootContext, 'presence' | 'dispatchToApp'>) {
  const places = new Map<string, { id: string; lat: number; lon: number }>()
  for (const { sessionId } of await presence.sessions({ route: '/' })) {
    const weather = await presence.read(sessionId, WeatherMachine)
    for (const p of weather?.places ?? []) places.set(p.id, { id: p.id, lat: p.lat, lon: p.lon })
  }
  if (places.size > 0) await dispatchToApp(ForecastCache, { type: 'REFRESH', places: [...places.values()] })
}

// examples/weather/boot.ts
export default defineBoot((ctx) => {
  const log = scopedLogger('weather')
  const poll = () => pollWatched(ctx).catch((err) => log.error({ err: String(err) }, 'forecast poll failed'))
  const stop = ctx.presence.watch({ route: '/', graceMs: 0 }, poll) // a new watcher is warmed at once
  const timer = setInterval(poll, 15 * 60_000)
  return () => { stop(); clearInterval(timer) }
})
```

- Demand is recomputed from the registry and the store on every tick. A session that disconnects is simply absent from the next tick. Nothing is counted, so nothing drifts.
- `ForecastCache` does not change. Its `REFRESH` guard already drops places that are fresh or in flight (`MIN_REFRESH_MS`), so a watch call caused by someone leaving costs one refused event.
- Cold start is the watch: page GET renders the loading state, the SSE connection registers, the listener polls, `LOADED` fans out. That replaces the island's mount tick. Returning to a hidden tab reconnects, which is a registry change, which polls; that replaces the island's `visibilitychange` tick.
- `refresh-clock.stator` is deleted. The manual refresh button (`REVALIDATE`) and `ADD_PLACE`'s emit stay: they are user intent, and the subscription path is still the only road from a browser to the cache.
- Cost: one store read per connected session per tick. With `CachedStore` in front that is a map lookup; at a 15-minute cadence it does not matter either way.
- Tests: `pollWatched` takes its two dependencies, so `tests/poll.test.ts` drives it with a fake `presence` (no watchers: no dispatch; two sessions sharing a place: one request for it; a session with no snapshot: skipped).
- Docs: `recipes/startup-and-background-work.md` currently recommends the client tick and names weather as the example; it changes to the demand-gated server poll. `ForecastCache`'s and `WeatherMachine`'s header comments describe the client clock and are rewritten.

### Single process and replicas

**3.x ships single-process presence.** `sessions()` and `watch()` see this process's connections only. That is the same limit fan-out and app machines have today, and the docs say it in the same breath.

**The designed-in upgrade** rides the Redis backplane, with no change to the three signatures:

- Each replica owns one slice of presence: its own derived set, published under its replica id with a heartbeat and a TTL. One writer per slice, so slices never conflict, and the cluster-wide set is their union. A replica that dies stops heartbeating and its slice expires. This is the same derive-don't-count rule one level up.
- `sessions()` returns the union (hence `Promise`). `read()` already works: the session store is shared.
- Grace is applied to the union. A refresh that lands on another replica is present there before it expires here.
- `watch` listeners feed app machines, and an app machine needs a single writer across replicas. Which replica runs the listener is the backplane's leader question, the same one every `boot.ts` loop and every `after` timer on an app machine already has. Presence adds no new instance of it.

Phoenix needs a CRDT for this step because its nodes gossip peer to peer with no hub. Stator's multi-replica design already assumes Redis as the hub, so owner-partitioned slices with TTLs are enough.

### Security and privacy

- **Who can ask.** Only server code: `boot.ts` and whatever holds the `StatorApp`. There is no client API, no endpoint, no template global. The dev inspector is not extended.
- **Who can see.** Whoever can open a route that reads a selector that exposes it. Visibility is the app's selector plus the route's existing admission, which is the model for every other piece of shared state. Presence counts only admitted connections.
- **Session ids.** `PresenceEntry.sessionId` is the raw id, because the app machine has to join it with `sourceSessionId`. The rule is the one live-poll already follows with `voterSessions`: session ids live in context, selectors return public shapes, keys are app-minted ids. The docs state it on the presence page in a caution block.
- **A net under the rule** (recommended, dev only): when a rendered or recomputed binding value, attribute, or list key equals a live connection's session id, the dev server logs a warning naming the route and machine. Cheap in dev, where there are a handful of connections, and it turns the privacy rule from prose into a check. Lives beside the poll-loop lint (`server/dev-lint.ts`).
- **Logs.** The presence module logs through `logSid` like the rest of `sse.ts`.
- **Persistence.** An app that stores the present set in a `persist: true` machine writes session ids to its app store. live-poll already does this with voter ids; the docs say so plainly, and transient context keys (deferred) are the eventual fix.

### Order of shipping

1. The read: `sessions` and `read`. Unblocks weather.
2. The watch. Unblocks planning-poker, and gives weather its cold start.
3. planning-poker and the weather refactor, each against the branch, each with its log.
4. Adjudicate the logs, then release the surface as Stable in one minor.

Presence events declared on a machine, and a presence value a template reads directly, are not on this list. See Alternatives.

## How far Stator goes: CRDTs and conflict resolution

### The claim, checked against the code

The starting position was: Stator is server-canonical, an app machine processes events in one total order, so concurrent writers are resolved by ordering plus guards, and CRDTs solve a different problem. That holds, with two qualifications.

**It holds in one process.** `actor.send` is synchronous and returns `void` (`engine/actor.ts`): guard, action, emit and any subscription cascade run to completion before the event loop takes another task. All three roads into an app machine call it synchronously: `dispatchToApp` (`server/app-dispatch.ts`), the session-to-app subscription listener (`SessionRuntime.wireSubscriptions`), and app-to-app wiring (`MachineStore.wireAppSubscriptions`). There is no lock on app machines because none is needed; the comment in `app-dispatch.ts` says "sends are atomic" and the code agrees. Session machines get the same guarantee from the per-session lock (`server/session-lock.ts`), since their load, mutate, persist cycle crosses awaits. So for every machine there is one order of events, and each guard sees the result of every event before it.

**Qualification one: the order covers events, not intentions.** A user decides on what their screen showed; the event arrives later; the state may have moved. And an effect's completion arrives after other events. The total order does not make either one correct. The chart does: a guard that checks the precondition, and for effects the stale-completion guard the effects guide already teaches.

**Qualification two: it does not hold across replicas.** Two processes are two app-machine instances that drift (`guides/app-machines.md`). The roadmap's answer is a Redis backplane with a single writer per app machine. That is the fork in the road: with more than one process, a system either keeps one authority and routes writes to it, or lets several authorities write and merges afterwards. Merging afterwards is what a CRDT is for. **Stator keeps one authority.** The multi-replica design must preserve one writer per machine, and this spec records that as a constraint on it.

### What a CRDT buys, and why Stator does not need it

A CRDT lets replicas accept writes independently and converge without coordination. That matters when there is no single authority at write time: offline editing, peer-to-peer, multi-region writes, or a text buffer where waiting a round trip per keystroke is unusable and two people type in the same paragraph.

Stator's premise is the opposite. The server holds the state, the browser holds none, every write is a round trip that a guard may refuse (`introduction/why-stator.md`: "What Stator deliberately does **not** do is optimistic updates"). With no second copy there is nothing to merge. Adding a CRDT layer to machine context would bring back the second copy the framework exists to remove, and it would cost the thing machines are for: a guard cannot refuse a merge.

### What Stator takes on

- **Concurrent writers to shared state.** Resolved by arrival order plus the chart. If the handler has no guard, the last writer wins. If it has one, the loser is refused and `committed: false` comes back. Which of the two applies is a decision the chart makes visibly, per event.
- **Stale intent.** The supported pattern is: the event carries what the sender saw (a round number, a row version), the guard compares, a mismatch refuses. planning-poker's `REVEAL { round }` is the small case; `stockroom`'s versioned saves are the storage case (`commitStock(id, draft, version)` and `SAVE_CONFLICT`). The 3.1 refusal-reasons feature is what makes the refusal *legible*: today the loser gets `committed: false` and no why. Reasons are the only conflict-resolution feature Stator needs to add, and they are already specced elsewhere. Nothing in this spec depends on them.
- **Presence.** Ephemeral, derived from connections, single-writer by construction (the registry). Covered above.
- **Low-rate shared ephemera.** "Is typing", "is looking at card 3", a raised hand. Ordinary app-machine state written by ordinary events, cleared by an `after` timer or by presence. A POST and a fan-out per change is the right cost at a few changes per second per room.

### What Stator does not take on

- **Optimistic UI and latency compensation.** None exists and none is planned (`concepts/events-and-dispatch.md`, `why-stator.md`). State that cannot wait for the network belongs in a client island.
- **Merge of concurrent edits to one value.** No field-level merge, no operational transform, no CRDT types in context. Two people editing the same title is last-writer-wins or a guard, as above.
- **Offline writes.** A page with no connection cannot dispatch. There is no queue-and-replay.
- **Collaborative text editing.** Out. This is the one mainstream feature where a CRDT is the right tool, and the tool is mature (Yjs, Automerge). Stator should host it, not reimplement it.
- **High-rate ephemera**: live cursors, selections, drag positions at 30 Hz. Each event would be a POST, a guard, and a recompute for every viewer. Wrong transport. These travel with the editing channel below.

### The seam for collaborative editing

A client island owns the document and its transport. Stator owns who may open it.

- The island runs Yjs (or Automerge) and connects to a sync provider: Hocuspocus or y-websocket beside the app, or a hosted one (Liveblocks, PartyKit). Cursors ride the provider's awareness channel.
- An API route issues the provider a short-lived token from the session's claims. That is the authorization step, and it is ordinary Stator: a guard or a route gate decides.
- The provider's persistence hook (or a webhook into an API route, then `dispatchToApp`) hands Stator the merged document when it wants to store, index, or render it server-side. To Stator that is one opaque value arriving in one event.
- Room membership, permissions, comments, the document list, "who is in this doc" at the page level: machines, as usual.

**What the framework needs for that: nothing new.** Islands, API routes, claims, and `dispatchToApp` exist. What Stator deliberately does not offer is being the relay itself. The one-way SSE channel carries DOM patches computed from state, and the only way to push bytes to another viewer's island today is to put them in machine state and bind an attribute, which re-sends the whole value per change. A broadcast channel for opaque messages to islands would close that, and it is the same gap `drydock` calls "session-scoped live channels" on the roadmap. If that primitive is ever built for its own evidence, a Yjs relay over it becomes a recipe. It is not built for this.

### Against the neighbours

- **Phoenix LiveView + Presence.** The closest relative, and the same boundary. LiveView state is server-held and processed one message at a time per process; there is no client merge. Phoenix Presence uses a CRDT *internally*, to replicate the presence list across a cluster with no central store. That is an implementation detail of cluster gossip, not a conflict-resolution feature offered to app state. Stator's presence in one process needs none of it, and across replicas a Redis hub with owner-partitioned slices replaces it.
- **Liveblocks, PartyKit.** Room servers: a stateful endpoint per room, presence and broadcast as primitives, storage as CRDT types or as Yjs. They are transports for client-held collaborative state. Stator overlaps with them only on presence and on "a room is a server-side thing". For conflict-free shared documents they are the thing an island connects to.
- **Yjs, Automerge, local-first.** The client is the authority and the server is a peer or a relay. That is the opposite premise from Stator's, and the two compose only at the island boundary described above.

### The statement the docs repeat

> Stator keeps one copy of your state, on the server, and changes it one event at a time. When two people act at once, one event runs first and the chart decides what happens to the second: it wins, or a guard refuses it. There is no merge step, so there are no merge conflicts and no CRDTs in your machines. Presence is built in. For the one thing that genuinely needs merging, people typing in the same document, run Yjs in a client island and let Stator decide who may open it.

## Alternatives Considered

- **Presence events declared on a machine** (`defineMachine({ presence: { route: '/r/:id', dispatch: 'PRESENCE' } })`). The nicest thing to write, and a new config key on the most load-bearing definition in the framework, for one consumer. It is a `source()` in the sense the roadmap defers. `watch` in `boot.ts` is the same wiring in three lines of userland; if two or three apps write those three lines identically, that is the promotion evidence, and the declarative form can compile to exactly this.
- **A built-in presence machine or a `present()` template binding** that routes read directly. A new binding source with its own touch semantics on the compose/identity seam, and it would have to expose session ids or invent a public identity scheme. `read()` over an app machine carries presence with nothing new.
- **Join and leave events instead of a set.** Edge-triggered delivery needs exactly-once to stay correct, and a crash between a join and its leave leaves a ghost in a persisted machine forever. The design note rejected event-sourced refcounts for weather for the same reason (fork B).
- **The read alone, with planning-poker polling it from `boot.ts`.** Smallest possible surface. But the debounce then lives in app state as last-seen timestamps, which commit and fan out on every tick, and arrival lags by the tick. Refresh debounce is the one hard part of presence; it should be written once, in the framework.
- **A sync `sessions()`.** Slightly nicer today and usable from a selector. It would have to stay sync forever, which forces the replicated-local-view design on the backplane before that design exists.
- **Reading the session machine off the connection's runtime** (design note option a). Zero I/O, but stale for unbound machines, absent during grace, wrong across replicas, and it leaks `SessionRuntime`.
- **A per-connection projector the app declares** (design note option c). The most machinery; bind-family risk; `read` does the same job from the app's side.
- **No session read at all: the app keeps a demand map.** `ForecastCache` would hold `wanted[sessionId] = places`, fed by the existing subscription, and each tick would prune it against `sessions()`. It works and needs only the read of who is connected. It costs a second copy of each session's places in an app machine, an emit on every place change and on connect, and the client's mount tick stays. It is the fallback if `read` is judged too large a capability.
- **Server-to-session dispatch** (tick `REVALIDATE` into each present session). A write capability to solve a read problem, and N locked hydrate-persist cycles per tick.
- **Demand TTL** (design note fork C). Needs a "still here" signal, which is the client tick again.
- **A framework-minted public member id** on each entry (a hash of the session id). The app machine would need the same function to line it up with `sourceSessionId`, so it is a second export for something `pid` in session context already does. Revisit if the paper-cut log says the indirection hurt.
- **Per-connection metadata on the entry** (Liveblocks-style `updateMyPresence`). A second state channel with no guards, no persistence story, and no chart. Everything it would carry is app state.

## Open Questions

- **Half-open departures.** A silently dead client stays present until TCP notices. Options if the poker log shows it matters: shorten the server ping, have the client acknowledge pings over a cheap request, or enable kernel keepalive on the socket. None is in scope until measured.
- **Is `read` on `presence`, or is it a general `readSession` helper?** Webhooks and API routes may want it for sessions that are not present. This spec puts it on `presence` because that is where the evidence is; the name and home are easy to widen and hard to narrow.
- **Default `graceMs`.** 5000 is a guess that covers a refresh and a dev rebuild. The log decides.
- **`params` only, or `query` too?** A room keyed by `?room=` cannot be filtered today. No consumer wants it.
- **Claims on the entry.** An app with sign-in could group by user without a join through its own machine. Deferred with the user lifecycle.
- **Should `watch` exist outside `boot.ts`?** `StatorApp.presence.watch` works for tests and custom servers. A machine or route calling it is not supported and has no way to get the object.
- **A room-scoped listener.** `watch` on `/r/:id` re-sends every room's set when one room changes. Fine for a starter; a `groupBy` option or a changed-keys argument is the obvious next step and waits for a second consumer.
- **Which minor.** 3.1 is committed to body limits and the machine-hash target. Presence can ride it or follow as 3.2.

## Implementation Notes

(Not yet implemented.) Proposed breakdown. PRs 1 and 2 are framework; 3 and 4 are examples and can run in parallel once 2 is on a branch; 5 is docs.

- **PR 1, framework, M. The read.** `server/sse.ts`: `urlPath` on `Connection` and `ConnectionInit`, internal `liveConnections()`. `server/http.ts`: pass `matched.route.urlPath` in the `/__sse` handler's `registerConnection` call (one line). New `server/presence.ts`: types, `createPresence(store)`, `sessions`, `read`. `server/boot.ts`: `presence` on `BootContext`. `server/create-app.ts`: construct, pass to `runBoot`, expose `StatorApp.presence`. `server/dev.ts`: `DevApp` is its own interface with its own `dispatchToApp` that closes over the current store across rebuilds; `presence` is added the same way (and wherever `dev-native.ts` runs boot). `server/index.ts`: export the types. Tests: new `tests/presence.test.ts` (two tabs are one entry with `connections: 2`; route and params filters; a closed connection is gone on the next call; `read` returns current state after a dispatch from another runtime, `undefined` for a session with no snapshot, fires no entry effect and persists nothing); `tests/boot.test.ts` (context carries `presence`); `tests/server-barrels.test.ts` (new exports); existing `tests/sse.test.ts` fixtures gain `urlPath` (11 `registerConnection` call sites). Changeset: minor.
- **PR 2, framework, M. The watch.** `server/sse.ts`: internal `onRegistryChange`, the rotate/clear flag from `closeSessionConnections`. `server/presence.ts`: `departed`, `derive`, `watch`, timers. Tests in `tests/presence.test.ts` with fake timers: initial call; arrival is immediate; second tab is silent; close then reopen inside grace is silent; departure fires once after grace with the entry gone; in-grace entries report `connections: 0`; rotate/clear skips grace; listener rejection is logged and the watch survives; overlapping changes collapse to one follow-up; stop function stops; shutdown (`closeLiveConnections`) leaves no timers.
- **PR 2b, framework, S, optional. The dev net.** `server/dev-lint.ts` plus a hook in the dev render/recompute path: warn when a bound value or list key equals a live session id. Test: a route that renders a session id warns once.
- **PR 3, example, L. planning-poker.** New `examples/planning-poker/` (machines, routes, templates, `boot.ts`, tests, README, design note), `packages/create-stator/index.js` template entry, `.chisel/docs/planning-poker-paper-cuts.md`. Tests: machine tests for the guards (`REVEAL` with a stale round is refused; unrevealed cards are absent from `table`); an integration test driving two sessions through `app.fetch` and calling the exported presence wiring by hand; a check that no response body or patch contains either session id.
- **PR 4, example, S. weather.** `examples/weather/boot.ts` and `lib/poll.ts` new; `templates/refresh-clock.stator` deleted and its use removed from `routes/index.stator`; header comments in `machines/forecast-cache.ts` and `machines/weather.ts`; `tests/poll.test.ts`; README. Findings appended to `.chisel/docs/presence-and-demand-gated-polling.md`.
- **PR 5, docs, M.** New `guides/presence.md` (the surface, the session-id caution, the single-replica caution, the hidden-tab and half-open notes). `reference/server.md`: `presence` beside `activeConnectionCount`, `BootContext`. `guides/app-machines.md` and `guides/realtime-sse.md`: the boundary statement and a link. `introduction/why-stator.md`: the boundary statement next to the optimistic-updates paragraph, with the Yjs seam. `recipes/startup-and-background-work.md` and `guides/effects.md` (the paragraph that says "put the clock on the client"): the demand-gated poll replaces the client-tick advice. ROADMAP: presence moves to Shipped, planning-poker to Shipped starters, and one line records "single writer per app machine" as a constraint on the backplane.

Sequencing note: nothing is released until the two logs are adjudicated. PRs 1 to 4 stack on a `feat/presence` branch; the changeset lands with PR 1 and the release is cut after PR 5.

## Decision record (2026-11-22, Tony)

Parked, with `planning-poker`. The feature needs further evidence before any of it is built: its motivation was the July gap-analysis thought experiment and an example that does not exist, and no app has stepped outside the framework for it. If evidence arrives, the smallest piece is the registry read alone (`presence.sessions()`); the watch, the grace period and `presence.read` are conveniences on top of it. The CRDT boundary section stands as written.
