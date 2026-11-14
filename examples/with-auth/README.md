# with-auth · The Quay Wall

A harbor notice board with accounts: anyone reads, members post, the harbormaster moderates. Built to answer the two questions every framework gets asked — *how do I do auth?* and *how does the server know who sent an event?* — with answers that are distinctly Stator's.

```sh
pnpm install
pnpm dev
# sign in as the harbormaster: harbormaster@quay.test / let-me-in
```

`boot.ts` creates the harbormaster account when the server starts, if it isn't there yet.

## The ideas, in the order they'll surprise you

The numbers match the `TEACHING MOMENT` comments in the code.

1. **Identity is addressing.** No event carries a userId — the HttpOnly session cookie routes every request into *that browser's* machines, and `AuthMachine` simply *is* the sender's identity. There's no field to forge. (`machines/auth.ts`)
2. **Login is a guarded transition.** `LOGIN {email, password}` verifies against the database *in the guard* (sync SQLite + scrypt); a wrong password is a guard drop — `committed: false`, nothing changed. The anti-pattern to never write: a bare `SET_IDENTITY` event. The wire accepts any event a page sends, with whatever payload the browser chooses, so an event must prove itself or grant nothing.
3. **Authenticate at the edge, authorize in guards.** Registration hashes the password in the API route — plaintext never enters the machine layer. Everything after that is guards: posting exists only in the `authenticated` state, moderation checks `role`, and withdrawal is checked by the *board* against the stamped requester (two machines, each defending its own invariant).
4. **Identity in emit payloads comes from server context, never the client event.** When a member posts, the emit's payload selector stamps `authorId` from `AuthMachine`'s own context — the trust boundary between "a browser said" and "the server knows". Posting goes through a form route, so the wire refuses a `POST_NOTICE` sent from devtools outright; `tests/auth.test.ts` sends one with a stuffed `authorId` straight to the machine and shows the payload ignores it.
5. **Private content never crosses the wire.** Members-only notices are filtered by a *server-side selector* per viewer (`visibleTo` in `machines/board.ts`) — a visitor's HTML (and their live-update stream) simply doesn't contain them. Not hidden with CSS: absent. Each SSE connection diffs against its own viewer's render, so a members-only post patches member pages and leaves visitor pages untouched. `GET /api/notices`, the board as JSON, filters the same way, so its body varies per viewer.
6. **Sessions rotate on privilege change.** Login/register call `rotateSession()` — the whole session moves to a fresh id, so a captured pre-login cookie is worthless. Logout uses `rotateSession({ clear: true })`: state deleted, fresh anonymous id. (`routes/auth/`)
7. **Middleware gates on claims; a fresh start is not a sign-out.** Middleware runs before any machine, so login also writes a minimal `{ userId, role }` into the session's *claims*, and `middleware.ts` bounces anonymous visitors from `/profile` to `/login`, remembering where they were headed (`returnTo`). The claims also outlive the machine state: when a deploy changes `auth.ts` and the snapshot is discarded, `AuthMachine`'s `seed` reads the user's row again from the claims' `userId`, so the session stays signed in.
8. **Per-user state is an app machine keyed by user.** Stator has session and app lifecycles, and no user lifecycle. `PrefsMachine` is an app machine holding each user's watched notices under their userId, so watches survive logout and follow the user to any browser. (`machines/prefs.ts`)

## Where things live

- **Accounts** → SQLite (`lib/db.ts`, `./harbor.db` or `WITH_AUTH_DB`): reference data, real storage that survives restarts.
- **Session identity** → `AuthMachine` (session): reactive, per-browser.
- **The board** → `BoardMachine` (app, `persist: true`): shared, live over SSE.
- **Watched notices** → `PrefsMachine` (app, `persist: true`, keyed by *userId*): per-**user** state.

`persist: true` saves app machines to the app store in `stator.config.ts`: Redis when `REDIS_URL` is set. Without it the store is in memory, so the board and watches reset when the server restarts while accounts don't.

## In production you'd add

Rate limiting on login attempts — the ~25–50ms of scrypt is a per-request cost, not a throttle (an attacker just uses a fresh session per guess), so pair it with real per-IP + per-account limits. A durable "remember me" token if you want logins to outlive the session TTL (store hashed tokens per user; re-authenticate on a fresh session; revoke server-side), password reset via your mailer, and HTTPS (the session cookie is `Secure` under NODE_ENV=production).

## CSRF posture

State-changing requests are cookie-authenticated (`stator_sid`). The framework defends them two ways: the cookie is `SameSite=Lax` (a cross-site POST won't carry it), and every mutating route (form POSTs and `/__events`) rejects browser requests whose `Sec-Fetch-Site`/`Origin` says `cross-site`. That covers classic cross-origin CSRF without a per-form token. Two caveats to know: a sibling **subdomain** is `same-site`, not cross-site, so it isn't blocked by either defense (use `SameSite=Strict` or an app check if subdomains are untrusted); and **login CSRF** specifically (forcing a victim to log in as the attacker) is only as strong as the Origin check — add a per-form token if that's in your threat model. Registration reveals whether an email already exists (`?error=exists`); swap for an email-verification flow if account enumeration matters.
