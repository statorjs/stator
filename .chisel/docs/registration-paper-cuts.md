# registration starter — paper-cut log

The evidence artifact the reactive-model spec's decision gate reads
([[isomorphic-reactive-model-read-for-display-on-for-events]], Minor C):
every place building a form-heavy app on the minimal surface (`ref:` + `on:` +
`read()` + platform constraints) was awkward, surprising, or forced a
workaround. Draft-ergonomics primitives are promoted FROM this log or not at
all — "a docs recipe" is an acceptable terminal answer.

Format: what happened → what it cost → what would have helped. Dated; append
as found; adjudicated at the gate.

---

## 1. A refused dispatch carries no reason (2026-08-09, build)

The desk refuses REGISTER for three distinguishable reasons — shape-invalid,
duplicate email, sold out — but the wire only says `committed: false`. The
island already knows the shape answers (it ran the same rules), so the real
loss is duplicate-vs-full: the form can only say "the desk refused this — the
event may be sold out, or this email is already on the roster."

**Cost**: one vague sentence where two precise ones belong.
**Would help**: a typed refusal channel on dispatch (`{ committed: false,
reason }` from a guard-declared vocabulary), or a blessed refusal-as-state
pattern that doesn't force the always-commit + lastResult contortion (which we
rejected here: it makes `committed` meaningless to the caller).
Ties to the server-only-events / origin-trust design thread.

## 2. Cross-session edits don't reach an uncontrolled input (2026-08-09, build)

The row-seats editor is uncontrolled by doctrine. Another desk resizing the
same party updates the roster (and any read()-driven text instantly), but not
this input's value — it shows the stale draft until reload. The snap-back
path has the same shadow: it restores `this.attrs.seats`, the render-time
truth, which another session may have moved since.

**Cost**: acceptable for this app (rare collision, visible seat counter), but
it's the sharpest edge of "never write a focused control" — the unfocused,
untouched case arguably COULD be written safely.
**Would help**: a safe-writeback helper with the focused/composing rules baked
in (the model spec's design notes describe exactly this) — a candidate for
promotion if more apps hit it.

## 3. Island templates can't see module constants (2026-08-09, build)

The ticket `<select>` wants its options from `TICKETS` in `lib/rules.ts` —
single source of truth — but an island template's server shell only sees
`props` (the script's imports are client-scope). Worked around by threading
`tickets={TICKETS}` from the route.

**Cost**: a prop that exists only to smuggle a constant; non-obvious failure
mode (dangling identifier at render) if you guess wrong.
**Would help**: island frontmatter imports usable in the shell, or a
documented "constants come in as props" note in the client-components guide.

## 4. Attrs-less islands rejected ALL shell props (2026-08-09, build) — FIXED IN-PR

`<RegForm tickets={TICKETS} />` failed typecheck: the `.d.ts` emitter only
opened the `[prop: string]: unknown` tail when `static attrs` existed, so an
island with none got `Record<string, never>` — contradicting the pinned
hydrate contract (shell props). First app to pass props to an attrs-less
island found it. Fixed in `compiler/dts.ts` + regression test, this PR.

## 5. Island dispatch double-applied keyed inserts (2026-08-09, browser) — FIXED IN-PR

First browser run: a submitted registrant appeared TWICE in the roster;
refresh fixed it. Root cause was framework-level: `clientId` (the page-load
identity fan-out uses to skip the dispatching page's own SSE connection) was
module-scoped — and the page runtime (prebuilt classic script) and island
modules (Vite graph) are separate bundles, each minting their own. An island
`dispatch()` therefore never matched the SSE connection's id, the originator
skip never fired, and the origin page re-received the roster patches — keyed
inserts are not idempotent. Every island dispatch on a live route had this;
it was invisible until now because text/attr patches ARE idempotent. Fixed:
`clientId` is a window-keyed page singleton (`client/client-id.ts`) +
regression test.

## 6. Editing: pre-fill-as-server-render held up (2026-08-09, build) — GOOD

The edit flow put the "form pre-filled from the server" case on the exit
checklist through the front door: `EDIT` snapshots the attendee into desk
context, the route flips between two `when()` arms, and the edit-mode island
shell renders `value=` attributes from the desk instance — the pre-filled
form is in the HTML (wire-testable with curl, no browser needed). Notes:
- `when()` has no else arm and passes no value — two complementary `when`s
  plus instance-proxy access (`desk.editing?.name`) inside the arm covered it
  cleanly, but an `unless`/else ergonomic would read better.
- The arm flip replaces the island wholesale, so update-mode teardown is free
  and the uncontrolled inputs never need a writeback.

## 7. Pre-fill proven through BOTH render pipelines (2026-08-09, build) — GOOD

Tony's call: the arm-flip edit delivers the pre-filled form through the patch
pipeline (recompute → `html` op → island upgrades in patched DOM), which is a
different code path from a full page render. Added `/edit/:id` — same island,
navigation-rendered, non-live, param → read → 404 — so both pipelines are
pinned by wire tests. The island grew one `done` attr (navigate on committed
save); nothing else changed. No friction found in either path.

## 8. read() display in the island needed nothing (2026-08-09, build) — GOOD

The four error lines and the refusal line are client-machine `read()` slots
(Minor B) — declared union on the checks machine, per-field events, zero
hand-wired DOM. The pattern held with no paper cut: this is the evidence FOR
the fold.
