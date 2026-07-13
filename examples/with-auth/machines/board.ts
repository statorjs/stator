import { defineMachine } from '@statorjs/stator/server'
import AuthMachine from './auth.ts'

/**
 * The shared notice board — one instance for every visitor, persisted.
 * Input arrives ONLY via AuthMachine's emits (see `subscribes`), whose
 * payloads carry server-stamped identity. This machine then enforces its
 * OWN rules against that trusted identity: ownership for withdrawals —
 * two layers of guards, each machine defending its own invariant.
 */

export interface Notice {
  id: string
  authorId: string
  authorName: string
  title: string
  body: string
  /** 'public' renders for everyone; 'members' only for signed-in viewers —
   *  filtered SERVER-SIDE, so a visitor's page never even receives it. */
  visibility: 'public' | 'members'
  pinned: boolean
  postedAt: number
}

type Events =
  | {
      type: 'ADD'
      authorId: string
      authorName: string
      title: string
      body: string
      visibility: 'public' | 'members'
    }
  | { type: 'WITHDRAW'; noticeId: string; requesterId: string }
  | { type: 'MODERATE'; noticeId: string; action: 'pin' | 'remove' }

let nextId = 0

export default defineMachine({
  name: 'BoardMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as Events,
  context: { notices: [] as Notice[] },
  initial: 'open',
  states: {
    open: {
      on: {
        ADD: {
          do: (ctx, ev) => {
            ctx.notices.unshift({
              id: `n${Date.now()}-${nextId++}`,
              authorId: ev.authorId,
              authorName: ev.authorName,
              title: ev.title.trim(),
              body: ev.body.trim(),
              visibility: ev.visibility === 'members' ? 'members' : 'public',
              pinned: false,
              postedAt: Date.now(),
            })
            if (ctx.notices.length > 100) ctx.notices.length = 100
          },
        },
        WITHDRAW: {
          // Ownership guard: the requesterId was stamped by AuthMachine's
          // emit payload (server context), so comparing it to the notice's
          // author is trustworthy.
          when: (ctx, ev) =>
            ctx.notices.some((n) => n.id === ev.noticeId && n.authorId === ev.requesterId),
          do: (ctx, ev) => {
            const i = ctx.notices.findIndex((n) => n.id === ev.noticeId)
            if (i !== -1) ctx.notices.splice(i, 1)
          },
        },
        MODERATE: {
          do: (ctx, ev) => {
            const i = ctx.notices.findIndex((n) => n.id === ev.noticeId)
            if (i === -1) return
            if (ev.action === 'remove') ctx.notices.splice(i, 1)
            else ctx.notices[i]!.pinned = !ctx.notices[i]!.pinned
          },
        },
      },
    },
  },
  subscribes: [
    { from: AuthMachine, event: 'noticePosted', dispatch: 'ADD' },
    { from: AuthMachine, event: 'withdrawRequested', dispatch: 'WITHDRAW' },
    { from: AuthMachine, event: 'moderationRequested', dispatch: 'MODERATE' },
  ],
  selectors: {
    all: (ctx) => [...ctx.notices].sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    /** The viewer-aware list: pages pass whether THIS viewer is a member.
     *  (`?? 'public'` tolerates snapshots from before the field existed.) */
    visibleTo: (ctx) => (member: boolean) =>
      [...ctx.notices]
        .filter((n) => member || (n.visibility ?? 'public') === 'public')
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    count: (ctx) => ctx.notices.length,
  },
})
