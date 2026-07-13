import { defineMachine } from '@statorjs/stator/server'
import AuthMachine from './auth.ts'

/**
 * Per-USER durable state — TEACHING MOMENT #4. Stator has session and app
 * lifecycles; "user" isn't one (yet — see the roadmap). The pattern: an app
 * machine holding userId-keyed slices. It survives logout and follows the
 * user to any browser, because the key is the user, not the session.
 *
 * Honest note on granularity: any change here re-diffs every live page
 * that reads this machine, though each page only renders its own slice —
 * correct by construction, coarser than a user-lifecycle primitive would be.
 */

type Events = { type: 'TOGGLE'; userId: string; noticeId: string; watching: boolean }

export default defineMachine({
  name: 'PrefsMachine',
  lifecycle: 'app',
  persist: true,
  events: {} as Events,
  context: { watches: {} as Record<string, string[]> },
  initial: 'ready',
  states: {
    ready: {
      on: {
        TOGGLE: {
          when: (_ctx, ev) => ev.userId !== '',
          do: (ctx, ev) => {
            const list = ctx.watches[ev.userId] ?? []
            const has = list.includes(ev.noticeId)
            if (ev.watching && !has) list.push(ev.noticeId)
            if (!ev.watching && has) list.splice(list.indexOf(ev.noticeId), 1)
            ctx.watches[ev.userId] = list
          },
        },
      },
    },
  },
  subscribes: [{ from: AuthMachine, event: 'watchToggled', dispatch: 'TOGGLE' }],
  selectors: {
    watchedBy: (ctx) => (userId: string) => ctx.watches[userId] ?? [],
  },
})
