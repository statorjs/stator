import { defineMachine } from '@statorjs/stator/server'
import { verifySource } from '../lib/webmention.ts'
import OwnerMachine from './owner.ts'
import ReceiverMachine from './receiver.ts'

export type MentionStatus = 'pending' | 'approved' | 'rejected'

export interface Mention {
  id: string
  source: string
  target: string
  postSlug: string
  kind: 'like' | 'repost' | 'reply' | 'mention'
  authorName: string
  authorUrl: string | null
  excerpt: string | null
  receivedAt: number
  status: MentionStatus
}

type MentionsContext = {
  mentions: Mention[]
  /** Per-mention verification workflows in flight — the collections-of-
   *  workflows shape: the machine-wide axis is trivial here, the per-record
   *  axis lives in this map, and completions land in machine-level `on:` so
   *  nothing can strand them. */
  verifying: Record<string, { source: string; target: string; postSlug: string }>
}

type MentionsEvents =
  | { type: 'RECEIVE'; id: string; source: string; target: string; postSlug: string }
  | {
      type: 'VERIFIED'
      id: string
      kind: 'like' | 'repost' | 'reply' | 'mention'
      authorName: string
      authorUrl: string | null
      excerpt: string | null
    }
  | { type: 'VERIFY_FAILED'; id: string }
  | { type: 'APPROVE'; id: string }
  | { type: 'REJECT'; id: string }

/** Interactions are bounded, reactive state — they live in a persisted app
 *  machine (the guestbook precedent), which is what makes a mention appear
 *  on a post page LIVE while someone reads it. The archive of posts lives in
 *  SQLite; the conversation around them lives here, capped. */
export const MAX_MENTIONS = 500

const MentionsMachine = defineMachine({
  name: 'MentionsMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as MentionsEvents,

  subscribes: [
    { from: ReceiverMachine, event: 'MENTION_RECEIVED', dispatch: 'RECEIVE' },
    { from: OwnerMachine, event: 'MENTION_APPROVED', dispatch: 'APPROVE' },
    { from: OwnerMachine, event: 'MENTION_REJECTED', dispatch: 'REJECT' },
  ],

  context: { mentions: [], verifying: {} } as MentionsContext,
  initial: 'open',
  states: {
    open: {
      on: {
        RECEIVE: {
          // The spec allows re-sent mentions to update earlier ones. The
          // starter dedupes instead — an update story is a good extension.
          when: (ctx, ev) =>
            !ctx.mentions.some((m) => m.source === ev.source && m.target === ev.target) &&
            !Object.values(ctx.verifying).some(
              (v) => v.source === ev.source && v.target === ev.target,
            ),
          do: (ctx, ev) => {
            ctx.verifying[ev.id] = {
              source: ev.source,
              target: ev.target,
              postSlug: ev.postSlug,
            }
          },
          effect: async (_ctx, ev): Promise<MentionsEvents | null> => {
            const verified = await verifySource(ev.source, ev.target).catch(() => null)
            if (!verified) return { type: 'VERIFY_FAILED', id: ev.id }
            return { type: 'VERIFIED', id: ev.id, ...verified }
          },
        },
      },
    },
  },

  // Completions and moderation land at machine level: no machine-wide state
  // can strand a per-mention workflow (the collections-of-workflows rule).
  on: {
    VERIFIED: (ctx, ev) => {
      const entry = ctx.verifying[ev.id]
      if (!entry) return
      delete ctx.verifying[ev.id]
      ctx.mentions.unshift({
        id: ev.id,
        source: entry.source,
        target: entry.target,
        postSlug: entry.postSlug,
        kind: ev.kind,
        authorName: ev.authorName,
        authorUrl: ev.authorUrl,
        excerpt: ev.excerpt,
        receivedAt: Date.now(),
        status: 'pending',
      })
      if (ctx.mentions.length > MAX_MENTIONS) ctx.mentions.length = MAX_MENTIONS
    },
    VERIFY_FAILED: (ctx, ev) => {
      delete ctx.verifying[ev.id]
    },
    APPROVE: (ctx, ev) => {
      const m = ctx.mentions.find((x) => x.id === ev.id)
      if (m) m.status = 'approved'
    },
    REJECT: (ctx, ev) => {
      const m = ctx.mentions.find((x) => x.id === ev.id)
      if (m) m.status = 'rejected'
    },
  },

  selectors: {
    approvedFor: (ctx) => (slug: string) =>
      ctx.mentions.filter((m) => m.postSlug === slug && m.status === 'approved'),
    approvedCountFor: (ctx) => (slug: string) =>
      ctx.mentions.filter((m) => m.postSlug === slug && m.status === 'approved').length,
    pending: (ctx) => ctx.mentions.filter((m) => m.status === 'pending'),
    pendingCount: (ctx) => ctx.mentions.filter((m) => m.status === 'pending').length,
  },
})

export default MentionsMachine
