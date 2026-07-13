# with-auth · The Quay Wall

A harbor notice board with accounts: anyone reads, members post, the
harbormaster moderates. Built to answer the two questions every framework
gets asked — *how do I do auth?* and *how does the server know who sent an
event?* — with answers that are distinctly Stator's.

```sh
pnpm install
pnpm dev
# sign in as the seeded harbormaster: harbormaster@quay.test / let-me-in
```

Requires **Node 24+** (`node:sqlite`).

## The six ideas, in the order they'll surprise you

1. **Identity is addressing.** No event carries a userId — the HttpOnly
   session cookie routes every request into *that browser's* machines, and
   `AuthMachine` simply *is* the sender's identity. There's no field to
   forge. (`machines/auth.ts`)
2. **Login is a guarded transition.** `LOGIN {email, password}` verifies
   against the database *in the guard* (sync SQLite + scrypt); a wrong
   password is a guard drop — `committed: false`, nothing changed. The
   anti-pattern to never write: a bare `SET_IDENTITY` event, because
   anything dispatchable is dispatchable from devtools.
3. **Authenticate at the edge, authorize in guards.** Registration hashes
   the password in the API route — plaintext never enters the machine
   layer. Everything after that is guards: posting exists only in the
   `authenticated` state, moderation checks `role`, and withdrawal is
   checked by the *board* against the stamped requester (two machines,
   each defending its own invariant).
4. **Identity in emit payloads comes from server context, never the
   client event.** When a member posts, the emit's payload selector stamps
   `authorId` from `AuthMachine`'s own context — the trust boundary between
   "a browser said" and "the server knows". (Try stuffing an `authorId`
   into the event via devtools; the tests do.)
5. **Private content never crosses the wire.** Members-only notices are
   filtered by a *server-side selector* per viewer — a visitor's HTML (and
   their live-update stream) simply doesn't contain them. Not hidden with
   CSS: absent. Each SSE connection diffs against its own viewer's render,
   so a members-only post patches member pages and leaves visitor pages
   untouched.
6. **Sessions rotate on privilege change.** Login/register call
   `rotateSession()` — the whole session moves to a fresh id, so a captured
   pre-login cookie is worthless. Logout uses `rotateSession({ clear: true })`:
   state deleted, fresh anonymous id.

## Where things live

- **Accounts** → SQLite (`lib/db.ts`): reference data, real storage.
- **Session identity** → `AuthMachine` (session): reactive, per-browser.
- **The board** → `BoardMachine` (app, persisted): shared, live over SSE.
- **Watched notices** → `PrefsMachine` (app, persisted, keyed by *userId*):
  per-**user** durable state — survives logout, follows you across
  browsers. Stator has no user lifecycle (yet — see the roadmap); this is
  the pattern in the meantime.

## In production you'd add

Rate limiting on login attempts (scrypt's ~50ms under the session lock is a
floor, not a strategy), a durable "remember me" token if you want logins to
outlive the session TTL (store hashed tokens per user; re-authenticate on a
fresh session; revoke server-side), password reset via your mailer, and
HTTPS (the session cookie is `Secure` under NODE_ENV=production).
