import { defineMachine } from '@statorjs/stator/server'
import { verifyOwnerPassword } from '../lib/site.ts'

/** A bounced compose submission, stashed so the re-rendered form pre-fills —
 *  server-canonical draft RECOVERY, not keystroke state (the input still owns
 *  its draft while typing; this exists only across a validation redirect).
 *  The photo file itself can't round-trip — browsers forbid pre-filling file
 *  inputs — so the text survives and the file is re-picked. */
export interface ComposeDraft {
  title: string
  content: string
  photoAlt: string
}

type OwnerContext = { authed: boolean; draft: ComposeDraft | null }

type OwnerEvents =
  | { type: 'LOGIN'; password: string }
  | { type: 'LOGOUT' }
  | { type: 'APPROVE_MENTION'; id: string }
  | { type: 'REJECT_MENTION'; id: string }
  | { type: 'RETRY_TARGET'; key: string }
  | { type: 'PUBLISH_TARGET'; postSlug: string; sourceUrl: string; target: string }
  | { type: 'STASH_DRAFT'; draft: ComposeDraft }
  | { type: 'CLEAR_DRAFT' }

/**
 * The owner's session — authentication in a guard, authorization on every
 * privileged event (the with-auth doctrine). Moderation and retry events
 * land here first because sessions can't dispatch to app machines directly:
 * the guard proves the sender is the owner, the emit carries the decision,
 * and the app machines subscribe. The wire can never forge an approval —
 * an unauthenticated session fails the guard and the event doesn't commit.
 */
const OwnerMachine = defineMachine({
  name: 'OwnerMachine',
  lifecycle: 'session',
  events: {} as OwnerEvents,

  emits: {
    MENTION_APPROVED: {
      payload: (_ctx: OwnerContext, ev: { id: string }) => ({ id: ev.id }),
    },
    MENTION_REJECTED: {
      payload: (_ctx: OwnerContext, ev: { id: string }) => ({ id: ev.id }),
    },
    TARGET_RETRIED: {
      payload: (_ctx: OwnerContext, ev: { key: string }) => ({ key: ev.key }),
    },
    TARGET_QUEUED: {
      payload: (
        _ctx: OwnerContext,
        ev: { postSlug: string; sourceUrl: string; target: string },
      ) => ({ postSlug: ev.postSlug, sourceUrl: ev.sourceUrl, target: ev.target }),
    },
  },

  context: { authed: false, draft: null } as OwnerContext,
  initial: 'idle',
  states: {
    idle: {
      on: {
        LOGIN: {
          when: (_ctx, ev) => verifyOwnerPassword(ev.password),
          do: (ctx) => {
            ctx.authed = true
          },
        },
        LOGOUT: (ctx) => {
          ctx.authed = false
        },
        APPROVE_MENTION: { when: (ctx) => ctx.authed, emit: 'MENTION_APPROVED' },
        REJECT_MENTION: { when: (ctx) => ctx.authed, emit: 'MENTION_REJECTED' },
        RETRY_TARGET: { when: (ctx) => ctx.authed, emit: 'TARGET_RETRIED' },
        PUBLISH_TARGET: { when: (ctx) => ctx.authed, emit: 'TARGET_QUEUED' },
        STASH_DRAFT: {
          when: (ctx) => ctx.authed,
          do: (ctx, ev) => {
            ctx.draft = ev.draft
          },
        },
        CLEAR_DRAFT: {
          when: (ctx) => ctx.authed,
          do: (ctx) => {
            ctx.draft = null
          },
        },
      },
    },
  },

  selectors: {
    authed: (ctx) => ctx.authed,
    draft: (ctx) => ctx.draft,
  },
})

export default OwnerMachine
