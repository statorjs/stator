---
title: Authentication
description: "Identity is addressing: sessions route requests into the right machines, so most auth vulnerabilities become unrepresentable rather than defended."
sidebar:
  order: 1
---

Most frameworks make auth a *discipline* problem — a list of things you must
remember in every handler: check the session, compare the owner, don't trust
the client's `userId`. Stator's architecture removes most of that list. This
recipe is the distilled version of the [`with-auth`
example](https://github.com/statorjs/stator/tree/main/examples/with-auth)
(`pnpm create stator my-app --template with-auth`) — read the example to see
it run; read this to graft it into your app.

## The one idea: identity is addressing

There is no `userId` on any wire event. The HttpOnly session cookie routes
every request into *that browser's* session machines — so a session machine
structurally **is** the sender's identity. `CartMachine` never checks who
sent `ADD`; it can only ever be the sender's cart. The most common access-
control bug (trusting a client-supplied user id) isn't defended against —
there's no parameter to forge.

Everything below builds on that.

## Accounts live in a database, not a machine

Machines hold live, reactive state. User accounts are *reference data*
nothing re-renders against — so they belong in real storage. `node:sqlite`
(Node 24+) is a good default: its synchronous API is exactly what guards and
frontmatter (both synchronous) can call directly.

```ts
// lib/db.ts
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('app.db')
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT,
  role TEXT DEFAULT 'member', pass_salt TEXT, pass_hash TEXT
)`)

export const findUserByEmail = (email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase())
```

Passwords: hash with `node:crypto` scrypt — no dependency.

```ts
// lib/passwords.ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(plain: string) {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: scryptSync(plain, salt, 64).toString('hex') }
}
export function verifyPassword(plain: string, salt: string, expected: string) {
  const actual = scryptSync(plain, salt, 64)
  const exp = Buffer.from(expected, 'hex')
  return actual.length === exp.length && timingSafeEqual(actual, exp)
}

// Constant-time verify. An unknown email still runs one scrypt against a decoy,
// so login latency doesn't reveal whether the account exists — otherwise the
// skipped derivation is a timing oracle that enumerates users.
const DECOY = hashPassword('decoy — never matches a real password')

export function verifyPasswordConstantTime(
  plain: string,
  creds: { salt: string; hash: string } | undefined,
) {
  const { salt, hash } = creds ?? DECOY
  const matched = verifyPassword(plain, salt, hash)
  return creds !== undefined && matched
}
```

## Login is a guarded transition

Credentials travel as a **form** (values → forms; events → intents), and the
`LOGIN` guard does the verification. A wrong password is a *guard drop* —
`committed: false`, the machine did not move, and there's no
half-authenticated state to fall into. Authentication fails closed by
construction.

```ts
// machines/auth.ts
export default defineMachine({
  name: 'AuthMachine',
  lifecycle: 'session',
  events: {} as { type: 'LOGIN'; email: string; password: string } | { type: 'LOGOUT' },
  context: { userId: '', name: '', role: '' },
  initial: 'anonymous',
  states: {
    anonymous: {
      on: {
        LOGIN: {
          // Constant-time: an unknown email still runs one (decoy) scrypt, so
          // response latency can't be used to enumerate accounts.
          when: (_ctx, ev) => {
            const u = findUserByEmail(ev.email)
            return verifyPasswordConstantTime(ev.password, u && { salt: u.pass_salt, hash: u.pass_hash })
          },
          do: (ctx, ev) => {
            // Guard passed — identity comes from the DB ROW, not the event.
            const u = findUserByEmail(ev.email)!
            ctx.userId = u.id; ctx.name = u.name; ctx.role = u.role
          },
          to: 'authenticated',
        },
      },
    },
    authenticated: { on: { LOGOUT: { to: 'anonymous', do: (ctx) => {
      ctx.userId = ''; ctx.name = ''; ctx.role = ''
    } } } },
  },
  selectors: {
    isAuthenticated: (ctx) => ctx.userId !== '',
    isAdmin: (ctx) => ctx.role === 'harbormaster',
  },
})
```

The password only ever transits one event into one guard — events aren't
persisted (only context snapshots are), and context stores *identity*, not
the credential.

:::danger[The one anti-pattern]
Never give a session machine a bare identity-granting event like
`SET_IDENTITY { userId, role }`. Anything dispatchable is dispatchable from
browser devtools via `/__events` — that would be instant privilege
escalation. An event must either **prove itself** (`LOGIN` carries
credentials) or **grant nothing**. The framework blocks its *own* generic
writes — reserved `@`-prefixed events (like the engine's built-in `@set`) are
rejected at `/__events` — but it can't stop you from *authoring* a forgeable
event, so this rule is yours to keep.
:::

## Register: hash at the edge

Registration is the one place plaintext exists — and it exists in a single
handler scope and dies there, hashed before anything else touches it. Then
log the new user in through the *same* guarded `LOGIN`.

```ts
// routes/auth/register.ts
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch, rotateSession }) => {
    const form = await request.formData()
    const email = String(form.get('email')).toLowerCase()
    const password = String(form.get('password'))
    if (findUserByEmail(email)) return { directives: [{ type: 'navigate', to: '/login?error=exists' }] }

    const { salt, hash } = hashPassword(password) // plaintext dies here
    createUser({ id: `u-${randomUUID()}`, email, name: String(form.get('name')), pass_salt: salt, pass_hash: hash })

    await dispatch(AuthMachine, { type: 'LOGIN', email, password })
    rotateSession()
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
```

## Authorization is guards

Two flavors, both plain guards:

**The state chart is the ACL.** Posting only exists in the `authenticated`
state — an anonymous `POST_NOTICE` isn't a 403, it's *not a transition*. To
audit your attack surface, read the chart: every state, every accepted event,
every guard.

**Role and ownership** are guard conditions:

```ts
// role — harbormaster only:
MODERATE: { when: (ctx) => ctx.role === 'harbormaster', emit: 'moderationRequested' },

// ownership — on the RECEIVING machine, against server-stamped identity:
WITHDRAW: {
  when: (ctx, ev) => ctx.notices.some((n) => n.id === ev.noticeId && n.authorId === ev.requesterId),
  do: (ctx, ev) => { /* remove */ },
},
```

## Identity in emits comes from context, never the event

When identity must cross into shared state (a member posts to a shared
board), the emit's **payload selector stamps identity from the machine's own
context** — never from the client's event. This is the trust boundary, and
it's a pure function you can grep for (`grep "payload:" machines/` is your
complete identity audit).

```ts
emits: {
  noticePosted: {
    payload: (ctx, ev) => ({
      authorId: ctx.userId,   // ← server context. NOT ev.authorId.
      title: ev.title,
    }),
  },
},
```

A hostile client can put `authorId: 'someone-else'` in the event; the
selector doesn't read it.

## Sessions rotate on privilege change

`rotateSession()` (an API-route helper) is the session-fixation defense: on
login it moves the whole session to a fresh id, so a cookie captured while
anonymous becomes worthless. On logout, `rotateSession({ clear: true })`
deletes the old session's state and issues a fresh anonymous id.

```ts
// login handler
const { committed } = await dispatch(AuthMachine, { type: 'LOGIN', email, password })
if (!committed) return { directives: [{ type: 'navigate', to: '/login?error=bad' }] }
rotateSession()
```

## CSRF: cookie writes are origin-checked

Every state-changing request is authenticated by the `stator_sid` cookie, so
cross-site request forgery is a concern the framework handles — no per-form
token required. Two defenses cover the classic cross-site POST: the cookie is
`SameSite=Lax` (a cross-site POST won't carry it), and every mutating route
(form POSTs **and** `/__events`) rejects browser requests whose `Sec-Fetch-Site`
/ `Origin` header says `cross-site`. Cookieless server-to-server callers
(webhooks) send no such header and are unaffected.

Two caveats worth keeping in your threat model:

- A sibling **subdomain** is `same-site`, not `cross-site`, so neither defense
  blocks it — use `SameSite=Strict` or an app-level check if you don't trust
  every subdomain on your registrable domain.
- **Login CSRF** (making a victim's browser sign in as the attacker) isn't
  fully neutralized by `SameSite` alone; add a per-form token on the login
  route if it's in scope for you.

## Bonus: private content never crosses the wire

To show members more than visitors, filter with a **viewer-aware selector**,
server-side — don't ship everything and hide with CSS. A visitor's HTML (and
their live-update stream) simply won't contain members-only content: absent,
not hidden.

```ts
selectors: {
  visibleTo: (ctx) => (isMember: boolean) =>
    ctx.notices.filter((n) => isMember || n.visibility === 'public'),
}
```

```astro
{each(read(board, (b) => b.visibleTo(isMember)), (n) => (/* … */))}
```

## In production you'd add

None of these teach a Stator-specific pattern, so the example leaves them
out — but a real app wants them:

- **Rate limiting** on login (scrypt's cost is a floor, not a strategy;
  `/__events` is a brute-force channel for the `LOGIN` guard without per-IP
  limits in front).
- **Account enumeration**: login is constant-time above, but registration still
  reveals whether an email is taken (`?error=exists`). Swap it for an
  email-verification flow if enumeration matters.
- **Durable "remember me"** if logins should outlive the session TTL: store
  hashed tokens per user, re-authenticate on a fresh session, revoke
  server-side. (A first-class token cookie is a roadmap candidate.)
- **Role revocation lag**: context copies the role at login, so demoting a
  user in the database doesn't kick their live session — re-read the role per
  privileged action, or keep sessions short.
- **Password reset** via your mailer, and HTTPS (the session cookie is
  `Secure` under `NODE_ENV=production`).
