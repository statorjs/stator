# registration — the front desk

An event registration desk, and Stator's forms proving ground. One shared roster (an app machine, live over SSE on every open desk), a registration form that checks your typing as you go, and a desk that checks everything again before a seat is taken.

```bash
pnpm install
pnpm dev
# open http://localhost:3000 — in two windows
```

The roster and sessions live in memory, so a restart empties the roster. Set `REDIS_URL` to keep both (`stator.config.ts`).

## What it teaches

**Forms without two-way binding.** The inputs own the draft — the platform's `required` / `type=email` / `min` / `max` / `maxlength` guard it natively, and nothing ever writes into a control the user is typing in. The commit boundary is one typed dispatch. A refused dispatch comes back `committed: false` and the form keeps your typing.

**Two validation tiers, one set of rules.**

- *Shape rules* (`lib/rules.ts`) are pure functions with no framework imports. The `reg-form` island runs them on blur for instant feedback, the desk machine's guard runs them again on the server, and the roster runs them a third time on arrival. The server never trusts the browser's copy.
- *Truth rules* only the server can answer — duplicate emails, the seat budget — live in the desk's guard, read live from the roster (`reads: [RosterMachine]`), and resolve races at the roster itself: two desks can both pass their guards in the same instant; arrival re-checks decide who got the last seat.

**Safe writeback moments.** The form resets only after its own successful commit (`form.reset()` — back to server-rendered defaults). The inline seats editor snaps back only after a refusal, on `change`, never mid-typing.

**Pre-filled controls.** Pre-fill is an attribute at render, never a live binding. A row's name links to `/edit/:id` — a plain navigable page whose form is server-rendered with the attendee's values. URL-addressable, refresh- and back-button-native, and deliberately not live.

**Live rows.** Every roster field an edit can change is a `read()` of the row, so an update patches that row in place on every open desk. The inline seats editor gets its value as a live attr and takes another desk's change only while you're not using it.

**Editing is an address, not machine state.** Holding an "editing" mode in the desk machine would let the *mode* survive refresh while the typing (uncontrolled inputs) didn't. A mode earns machine residence only when guards or domain logic act on it (a checkout's states qualify); a mode with one render-region consumer belongs to the URL.

**Acknowledgements are view state.** The "you're on the list" confirmation is a flash, an acknowledgement of *your* recent action. In session state it would survive refresh and outlive its moment, so it lives in the form island's client machine and dies with the page, which is its correct lifetime. The durable truth is the roster row itself. Net effect: the desk machine holds no context at all — it is guards + emits, a pure routing layer.

## Layout

```
machines/roster.ts    the shared roster (app machine, live, race-resolving re-checks)
machines/desk.ts      per-session desk (typed events, guards, reads the roster)
lib/rules.ts          the shape rules — pure, shared by both tiers, tested
templates/reg-form.stator      the form island (client checks, typed commit)
templates/row-seats.stator     inline seats editor (uncontrolled, commit on change, live attr in)
routes/index.stator   the live desk page, roster rows inline
routes/edit/[id].stator  the standalone edit page (full server render, not live)
tests/                rules, roster, and the full wire arc
stator.config.ts      Redis persistence when REDIS_URL is set
```
