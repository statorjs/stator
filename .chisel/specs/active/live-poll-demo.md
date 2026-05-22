---
title: Live poll demo
status: draft
created: 2026-05-21
updated: 2026-05-21
area: demo
---

## What and Why

The ecommerce demo proved the framework's runtime model in a "single-user-with-an-admin-view" shape. The poll demo is the next dogfood, shaped specifically to stress the patterns that ecommerce didn't.

Where ecommerce was "one user buys things, one admin watches," polls are "many anonymous users converge on the same shared state." The architecture's claim is that this is where slot-level live updates earn their place. A poll site is the smallest application that puts that claim under load.

The why this demo specifically:

- It's the smallest credible "live SSE" use case. Easier to explain than the admin dashboard, more shareable as a link.
- It exercises cross-lifecycle subscriptions in their canonical shape (session-machine emits, app-machine aggregates, `sourceSessionId` auto-injected).
- It surfaces framework gaps we already know exist (path params, app-machine persistence, no rate limiting) without trying to solve all of them at once.
- It's a real-shaped product, not a contrived example. A polling site is a thing people build.

## Success Criteria

- A user can open `/` and see a list of recent polls plus a "create poll" link.
- A user can create a poll with a question and 2-6 options at `/new`.
- The created poll lives at `/p/[id]` where `id` is a short generated slug.
- A user visiting `/p/[id]` who hasn't voted sees the options as buttons.
- After voting, the page swaps to a live results view showing vote counts and percentages.
- A second tab (or session) on the same `/p/[id]` URL sees vote counts update live as other sessions vote, without polling or reload.
- One vote per session per poll, strict. The same session attempting to vote again is a no-op rejected at the app machine.
- Poll creation goes through cross-machine subscription, not direct events to the app machine. Consistent with the framework's preferred pattern.

## Constraints

- Anonymous sessions only. No auth. The session cookie identifies a voter.
- In-memory storage for the polls themselves. App-machine state isn't persisted by the Store today. Restart wipes all polls. Documented as a known limitation. The app-machine-persistence spec covers the fix path.
- No rate limiting on poll creation in the first cut. Abusable, but the demo isn't public-traffic-exposed yet. When it goes online, rate limiting becomes a real concern; defer to a later spec.
- No vote-changing. Once a session votes, the choice is final. Keeps the data model simple and the demo focused.
- Question and option text are user-supplied strings. Sanitize at the wire edge to prevent HTML injection in displayed text.

## Approach

**Machines:**

- `PollsMachine` (app-lifecycle). Holds `polls: Record<pollId, { question, options: [{ id, text, count }], createdAt, voterSessions: Set<sid> }>`. Receives `POLL_CREATED` and `VOTED` events via cross-machine subscription from `VoterMachine`. Auto-injected `sourceSessionId` lets it track per-session voting state.
- `VoterMachine` (session-lifecycle). Holds `votedIn: Record<pollId, optionId>`. The user's own voting record, for "did I already vote in this one" UI checks. Emits `POLL_CREATED` and `VOTED`.

All client events POST to `VoterMachine`. `PollsMachine` is purely subscription-driven, never targeted directly from the client. This matches the framework's preferred event-flow shape: events touch session machines first, app aggregation happens via declared subscriptions.

**Routes** (using the new bracket-convention path params):

- `apps/poll/routes/index.ts` → `GET /`. Lists polls (most recent first), shows "create" button.
- `apps/poll/routes/new.ts` → `GET /new`. Form for creating a poll. Two options shown by default, "add option" button up to 6.
- `apps/poll/routes/p/[id].ts` → `GET /p/:id`. Conditional render: vote form if `voter.votedIn[id]` is unset, live results otherwise. `live: true`.

**Templates:**

- `layout.ts` — shared chrome (header, footer, link to /). No machine reads other than VoterMachine's `votedCount` for the header.
- `home-page.ts` — list of polls.
- `new-poll-page.ts` — create form. Uses dynamic option-row addition via cart-style increments. POSTs `CREATE_POLL` to VoterMachine on submit.
- `poll-page.ts` — vote view or results view, gated by a `when()` reading `voter.votedIn[id]`.

**Cross-machine wiring:**

```
VoterMachine emits POLL_CREATED { question, options }
  → PollsMachine subscribes, dispatches CREATE_POLL
    → PollsMachine generates id, adds to polls map
    → patches go to anyone on / (poll list updates)

VoterMachine emits VOTED { pollId, optionId }
  → PollsMachine subscribes, dispatches RECORD_VOTE
    → PollsMachine increments count, adds session to voterSessions
    → patches go to anyone on /p/:id (vote count updates)
```

`sourceSessionId` is auto-injected by the framework, used to prevent double-voting and to update the voter's own record.

Actually wait: the voter's own record (`votedIn`) is stored in VoterMachine which is session-scoped, so it doesn't need cross-machine. The flow is:

1. Click vote button → VoterMachine receives `VOTE` event (client-shaped) → updates `votedIn[pollId]` → emits `VOTED` with full payload.
2. PollsMachine subscribes to `VOTED`, dispatches `RECORD_VOTE` with sourceSessionId.
3. PollsMachine validates (not already voted), records, fan-out fires.

The two state changes happen atomically within one POST, the patches go out together.

**Persistence:**

- VoterMachine's state goes through the Store as normal (per-session, with TTL refresh on activity).
- PollsMachine is app-lifecycle. State is in-process only. Restart = lost polls. Known limitation, deferred to app-machine-persistence spec.

**ID generation:**

- 8-character base36 slug per poll, generated server-side. Collision check against existing polls before commit (one-in-2-billion at low volume).

## Alternatives Considered

- **PollsMachine session-lifecycle, keyed by poll id.** Considered to get persistence for free via the existing Store. Rejected because polls are shared, not session-scoped, and treating them as "sessions" abuses the lifecycle concept.
- **Direct client events to PollsMachine.** Considered for simplicity. Rejected because it skips the cross-machine subscription pattern, which is one of the things this demo is supposed to stress. Going through VoterMachine + subscriptions also enforces the source-session identity for free.
- **Vote-changing UX.** Considered. Rejected for first cut. Adds data-model complexity (need to track current vote to subtract on change) without much demo value.

## Open Questions

- Rate limiting. Public deployment without rate limiting on poll creation invites abuse. Easy first defense: cookie-based "one poll created per session per minute," enforced in VoterMachine's CREATE_POLL handler. Defer until pre-deploy.
- "Recent polls" listing. With in-memory storage, the list is bounded by what's currently in memory. Once persistence lands, the same list could grow unboundedly and needs pagination. Defer to when persistence lands.
- Total-votes counter on the home page. Could be a fun aggregate. Trivial selector on PollsMachine. Add if visual interest needs it.

## Implementation Notes

(Will fill in after build. The cross-machine flow described above will be the most interesting part to watch in the inspector — every vote should produce a visible VOTED emit and a corresponding RECORD_VOTE dispatch with the auto-injected sourceSessionId visible in the patch detail.)
