import { defineMachine } from '@statorjs/stator/server'
import { findUserByEmail, updateUserName } from '../lib/db.ts'
import { verifyPasswordConstantTime } from '../lib/passwords.ts'

/**
 * The session's identity — TEACHING MOMENT #1: identity is ADDRESSING.
 * There is no userId on any wire event; this machine simply *is* the
 * sending browser's session, keyed by the HttpOnly session cookie. Once
 * context says who you are, every later event from this session carries
 * that identity implicitly.
 *
 * LOGIN is a guarded transition — authentication IS authorization's little
 * sibling here. The guard verifies credentials against the database
 * (sync SQLite + scrypt, both fine in a guard); a wrong password is a
 * guard drop: `committed: false`, no state change, nothing to forge.
 *
 * ANTI-PATTERN WARNING: never give a session machine a bare
 * "SET_IDENTITY {userId, role}" event. Anything dispatchable is
 * dispatchable from browser devtools via /__events — an event must either
 * prove itself (LOGIN carries the password) or grant nothing.
 */

type Events =
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'SET_NAME'; name: string }
  | { type: 'POST_NOTICE'; title: string; body: string; membersOnly: boolean }
  | { type: 'WITHDRAW_NOTICE'; noticeId: string }
  | { type: 'MODERATE'; noticeId: string; action: 'pin' | 'remove' }
  | { type: 'WATCH'; noticeId: string }
  | { type: 'UNWATCH'; noticeId: string }

export default defineMachine({
  name: 'AuthMachine',
  lifecycle: 'session',
  events: {} as Events,
  emits: {
    // TEACHING MOMENT #3: identity in emit payloads comes from THIS
    // machine's own context — never from the client's event. The payload
    // selector runs server-side after the guard passed; it is the trust
    // boundary between "a browser said" and "the server knows".
    noticePosted: {
      payload: (ctx, ev: { title: string; body: string; membersOnly: boolean }) => ({
        authorId: ctx.userId,
        authorName: ctx.name,
        title: ev.title,
        body: ev.body,
        visibility: ev.membersOnly ? 'members' : 'public',
      }),
    },
    withdrawRequested: {
      payload: (ctx, ev: { noticeId: string }) => ({
        noticeId: ev.noticeId,
        requesterId: ctx.userId,
      }),
    },
    moderationRequested: {
      payload: (_ctx, ev: { noticeId: string; action: string }) => ({
        noticeId: ev.noticeId,
        action: ev.action,
      }),
    },
    watchToggled: {
      payload: (ctx, ev: { noticeId: string; type: string }) => ({
        userId: ctx.userId,
        noticeId: ev.noticeId,
        watching: ev.type === 'WATCH',
      }),
    },
  },
  context: { userId: '', name: '', role: '' },
  initial: 'anonymous',
  states: {
    anonymous: {
      on: {
        LOGIN: {
          // Authentication as a guard: wrong credentials = committed:false.
          // Constant-time: an unknown email still runs one scrypt (decoy), so
          // response latency doesn't reveal whether the account exists.
          when: (_ctx, ev) => {
            const user = findUserByEmail(ev.email)
            return verifyPasswordConstantTime(
              ev.password,
              user && { salt: user.pass_salt, hash: user.pass_hash },
            )
          },
          do: (ctx, ev) => {
            // Guard passed — identity facts come from the DATABASE ROW, not
            // the event. (The password is never written anywhere: events
            // aren't persisted, only context snapshots are.)
            const user = findUserByEmail(ev.email)
            if (user) {
              ctx.userId = user.id
              ctx.name = user.name
              ctx.role = user.role
            }
          },
          to: 'authenticated',
        },
      },
    },
    authenticated: {
      on: {
        LOGOUT: {
          to: 'anonymous',
          do: (ctx) => {
            ctx.userId = ''
            ctx.name = ''
            ctx.role = ''
          },
        },
        SET_NAME: {
          when: (_ctx, ev) => ev.name.trim().length > 0,
          do: (ctx, ev) => {
            ctx.name = ev.name.trim()
          },
          // The database write belongs in an effect — the sanctioned home
          // for side effects (actions must stay pure state mutations).
          effect: async (ctx, _ev, _meta): Promise<Events | null> => {
            updateUserName(ctx.userId, ctx.name)
            return null
          },
        },
        // TEACHING MOMENT #2 (half one): posting requires being logged in —
        // the state chart itself is the authorization (these transitions
        // don't exist in `anonymous`).
        POST_NOTICE: {
          when: (_ctx, ev) => ev.title.trim().length > 0,
          emit: 'noticePosted',
        },
        WITHDRAW_NOTICE: {
          emit: 'withdrawRequested',
        },
        MODERATE: {
          // TEACHING MOMENT #2 (half two): role checks are plain guards.
          when: (ctx) => ctx.role === 'harbormaster',
          emit: 'moderationRequested',
        },
        WATCH: { emit: 'watchToggled' },
        UNWATCH: { emit: 'watchToggled' },
      },
    },
  },
  selectors: {
    isAuthenticated: (ctx) => ctx.userId !== '',
    userId: (ctx) => ctx.userId,
    name: (ctx) => ctx.name,
    isHarbormaster: (ctx) => ctx.role === 'harbormaster',
  },
})
