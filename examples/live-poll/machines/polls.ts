import { defineMachine } from '@statorjs/stator/machine'
import VoterMachine from './voter.ts'

export type PollOption = {
  id: string
  text: string
  count: number
}

export type Poll = {
  id: string
  question: string
  options: PollOption[]
  createdAt: number
  /** Session ids that have already voted in this poll. Strict one-per-session. */
  voterSessions: Record<string, true>
}

type PollsContext = { polls: Record<string, Poll> }

// A browser cannot reach an app machine. Both events arrive through the
// subscriptions below, from the session's VoterMachine, and the framework adds
// `sourceSessionId`: the session that emitted. That id is how a vote is
// attributed, and it is never something the browser supplied.
type PollsEvents =
  | { type: 'CREATE_POLL'; question: string; options: string[]; sourceSessionId: string }
  | { type: 'RECORD_VOTE'; pollId: string; optionId: string; sourceSessionId: string }

const genId = (length: number): string =>
  Math.random()
    .toString(36)
    .slice(2, 2 + length)

/** The payload began as JSON from a browser, so it is cleaned here, not trusted. */
const cleanOptions = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : [])
    .map((o) => String(o ?? '').trim().slice(0, 100))
    .filter((text) => text.length > 0)
    .slice(0, 6)

const votesIn = (poll: Poll): number => poll.options.reduce((sum, o) => sum + o.count, 0)

export default defineMachine({
  name: 'PollsMachine',
  lifecycle: 'app',
  // Polls outlive a restart when the app has a durable app store
  // (stator.config.ts); without one this is in memory, like everything else.
  persist: true,
  events: {} as PollsEvents,
  subscribes: [
    { from: VoterMachine, event: 'POLL_CREATED', dispatch: 'CREATE_POLL' },
    { from: VoterMachine, event: 'VOTED', dispatch: 'RECORD_VOTE' },
  ],
  context: { polls: {} } as PollsContext,
  initial: 'ready',
  states: {
    ready: {
      on: {
        CREATE_POLL: {
          when: (_ctx, ev) =>
            String(ev.question ?? '').trim().length > 0 && cleanOptions(ev.options).length >= 2,
          do: (ctx, ev) => {
            let id = genId(8)
            while (ctx.polls[id]) id = genId(8)
            ctx.polls[id] = {
              id,
              question: String(ev.question).trim().slice(0, 200),
              options: cleanOptions(ev.options).map((text) => ({ id: genId(4), text, count: 0 })),
              createdAt: Date.now(),
              voterSessions: {},
            }
          },
        },
        RECORD_VOTE: {
          // The rule this app exists to show: one vote per session per poll.
          // A refused event changes nothing, so nothing is pushed to anyone.
          when: (ctx, ev) => {
            const poll = ctx.polls[String(ev.pollId)]
            return (
              !!poll &&
              !!ev.sourceSessionId &&
              !poll.voterSessions[ev.sourceSessionId] &&
              poll.options.some((o) => o.id === ev.optionId)
            )
          },
          do: (ctx, ev) => {
            const poll = ctx.polls[ev.pollId]!
            poll.options.find((o) => o.id === ev.optionId)!.count += 1
            poll.voterSessions[ev.sourceSessionId] = true
          },
        },
      },
    },
  },
  // Selectors shape what a page needs, and nothing more: no page is handed
  // `voterSessions`, and a list that shows no counts is not re-rendered by a
  // vote.
  selectors: {
    byId: (ctx) => (id: string): Poll | undefined => ctx.polls[id],
    totalCount: (ctx) => Object.keys(ctx.polls).length,
    /** The home page's rows, newest first. */
    summaries: (ctx) =>
      Object.values(ctx.polls)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => ({ id: p.id, question: p.question, options: p.options.length, votes: votesIn(p) })),
    /** The ballot: what can be chosen. It does not change as votes arrive. */
    choices: (ctx) => (id: string) =>
      (ctx.polls[id]?.options ?? []).map((o) => ({ id: o.id, text: o.text })),
    /** The results: each option with its count and its share of the vote. */
    results: (ctx) => (id: string) => {
      const poll = ctx.polls[id]
      if (!poll) return []
      const total = votesIn(poll)
      return poll.options.map((o) => ({
        ...o,
        pct: total === 0 ? '0.0' : ((o.count / total) * 100).toFixed(1),
      }))
    },
    votes: (ctx) => (id: string) => {
      const poll = ctx.polls[id]
      return poll ? votesIn(poll) : 0
    },
  },
})
