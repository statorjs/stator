---
title: Lifetime contract review for time-extended features
status: draft
created: 2026-07-25
updated: 2026-07-25
area: process
---

## Context

`after` shipped in 1.0 with a well-designed API shape (the described-trigger object deliberately left room for dynamic delays and durable schedules) but an incomplete semantic contract: nobody asked what a state timeout means across hydration. The result was two silent correctness holes that survived a full release — a machine persisted mid-entry-effect wedged forever, and a hydrated state never re-armed its countdown — plus a conflation of machine activity with user activity that made self-rescheduling sessions immortal. All three were found by dogfooding, not review, and all three were answerable in minutes had the question been asked at design time.

The pattern generalizes. Stator's execution model has three lifetimes — connection (ms–hours), session (hours–days, store TTL), process (until restart) — and any feature whose behavior extends over time crosses their boundaries. State crosses them cleanly by construction; behavior only crosses them cleanly when someone writes down what each crossing means.

## Decision

Any PR introducing or materially changing a feature that extends over time — timers, effects, held resources, polling, queues, future activities or durable work — must include a lifetime contract: a filled-in answer for every cell of this table that applies, in the PR description or the feature's spec.

| Boundary event | Question the contract must answer |
| --- | --- |
| State exit | Is in-flight work cancelled, abandoned, or completed? Who observes the difference? |
| Hydration (every request) | Does the work re-arm / re-invoke / no-op? What prevents per-request duplication or starvation? |
| Process restart | What survives, what is lost, what recovers on next contact — and is a wedged state reachable? |
| Session idle (no connections) | Does the work continue? Should it? What does it cost when nobody observes it? |
| Session expiry (TTL) | What is released or leaked? Does the feature's own activity extend the TTL it lives under? |
| Connection close | Is anything scoped to the connection that pretends to be longer-lived (or vice versa)? |

Two standing sub-rules extracted from the `after`/effects post-mortem:

- **Role before mechanism.** If the feature runs user code with side effects, classify the code's role first (load vs command was the split that made re-invocation safe by category rather than by author discipline) — a delivery guarantee without a role classification is a convention waiting to fail.
- **Activity is not user activity.** Machine-driven work must never masquerade as user presence (TTL refresh, presence counters, rate limits). Any path that touches those must declare which kind of activity it is.

Reviewers treat a missing or hand-waved cell the way they treat a missing test: the PR is not done.

## Consequences

Easier: catching wedges, immortality bugs, and duplication/starvation races at design time — each historical instance of these was a one-table-cell question. Cheaper API evolution: contracts written down before shipping are additive to extend, as the `enteredAt`/`pendingEntry` retrofits showed; contracts discovered after shipping risk breaking changes. Better docs for free: the filled table is the skeleton of the feature's "what happens when" documentation.

Harder: a small fixed cost per time-extended PR, and the discipline to reject PRs that skip it. The table does not cover multi-process deployments (app machines are process singletons; a Redis-backed multi-process story would add a fourth plane) — extend the table before relying on it there.

Reference analyses: the behavior-lifetimes design document (problem statement, use-case catalog U1–U13, primitive layering L1–L5), and the work-lifetime contract implementation (`packages/stator/tests/work-lifetime.test.ts` shows the wedge repros as executable form).
