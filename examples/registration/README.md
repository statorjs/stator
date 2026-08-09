# registration — the front desk

An event registration desk, and Stator's forms proving ground. One shared
roster (an app machine, live over SSE on every open desk), a registration
form that checks your typing as you go, and a desk that checks everything
again before a seat is taken.

```bash
pnpm install
pnpm dev
# open http://localhost:3006 — in two windows
```

## What it teaches

**Forms without two-way binding.** The inputs own the draft — the platform's
`required` / `type=email` / `min` / `max` / `maxlength` guard it natively, and
nothing ever writes into a control the user is typing in. The commit boundary
is one typed dispatch. A refused dispatch comes back `committed: false` and
the form keeps your typing.

**Two validation tiers, one set of rules.**

- *Shape rules* (`lib/rules.ts`) are pure functions with no framework imports.
  The `reg-form` island runs them on blur for instant feedback, the desk
  machine's guard runs them again on the server, and the roster runs them a
  third time on arrival. The server never trusts the browser's copy.
- *Truth rules* only the server can answer — duplicate emails, the seat
  budget — live in the desk's guard, read live from the roster
  (`reads: [RosterMachine]`), and resolve races at the roster itself: two
  desks can both pass their guards in the same instant; arrival re-checks
  decide who got the last seat.

**Safe writeback moments.** The form resets only after its own successful
commit (`form.reset()` — back to server-rendered defaults). The inline seats
editor snaps back only after a refusal, on `change`, never mid-typing.

**Pre-filled controls.** Each roster row's seats input is server-rendered with
its value — pre-fill is an attribute at render, not a live binding.

## Layout

```
machines/roster.ts    the shared roster (app machine, live, race-resolving re-checks)
machines/desk.ts      per-session desk (typed events, guards, reads the roster)
lib/rules.ts          the shape rules — pure, shared by both tiers, tested
templates/reg-form.stator      the form island (client checks, typed commit)
templates/row-seats.stator     inline seats editor (uncontrolled, commit on change)
templates/attendee-row.stator  one roster row
routes/index.stator   the live desk page
tests/                rules, roster, and the full wire arc
```
