import { defineMachine } from '@statorjs/stator/server'
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

type PollsContext = {
  polls: Record<string, Poll>
  /** The id of the most recently created poll. Used by the POLL_CREATED
   *  emit payload selector to surface the new poll without an out-of-band
   *  lookup. Stable for the duration of one transition. */
  lastCreatedPollId: string | null
  /** The (pollId, sessionId) of the most recent vote. Used by VOTE_RECORDED. */
  lastVote: { pollId: string; sessionId: string } | null
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function genOptionId(): string {
  return Math.random().toString(36).slice(2, 6)
}

export default defineMachine({
  name: 'PollsMachine',
  lifecycle: 'app',
  reads: [],

  // Session machines emit POLL_CREATED / VOTED; we subscribe with auto-injected
  // sourceSessionId. The framework's cross-lifecycle delivery path threads the
  // sid into the event, which is how we attribute votes to sessions.
  subscribes: [
    { from: VoterMachine, event: 'POLL_CREATED', dispatch: 'CREATE_POLL' },
    { from: VoterMachine, event: 'VOTED', dispatch: 'RECORD_VOTE' },
  ],

  emits: {
    POLL_CREATED: {
      payload: (ctx: PollsContext) => ({
        poll: ctx.lastCreatedPollId ? ctx.polls[ctx.lastCreatedPollId] : null,
      }),
    },
    VOTE_RECORDED: {
      payload: (ctx: PollsContext) => ({
        poll: ctx.lastVote ? ctx.polls[ctx.lastVote.pollId] : null,
      }),
    },
  },

  context: {
    polls: {},
    lastCreatedPollId: null,
    lastVote: null,
  } as PollsContext,

  initial: 'ready',
  states: {
    ready: {
      on: {
        CREATE_POLL: {
          actions: 'createPoll',
          emit: 'POLL_CREATED',
        },
        RECORD_VOTE: {
          actions: 'recordVote',
          emit: 'VOTE_RECORDED',
        },
      },
    },
  },

  actions: {
    createPoll: (ctx, ev) => {
      const question = String(ev.question ?? '').trim().slice(0, 200)
      const rawOptions = Array.isArray(ev.options) ? (ev.options as unknown[]) : []
      if (!question || rawOptions.length < 2) {
        ctx.lastCreatedPollId = null
        return
      }
      const options: PollOption[] = rawOptions
        .map((o) => String(o ?? '').trim().slice(0, 100))
        .filter((t) => t.length > 0)
        .slice(0, 6)
        .map((text) => ({ id: genOptionId(), text, count: 0 }))
      if (options.length < 2) {
        ctx.lastCreatedPollId = null
        return
      }

      let id = genId()
      while (ctx.polls[id]) id = genId()

      ctx.polls[id] = {
        id,
        question,
        options,
        createdAt: Date.now(),
        voterSessions: {},
      }
      ctx.lastCreatedPollId = id
    },

    recordVote: (ctx, ev) => {
      const pollId = String(ev.pollId ?? '')
      const optionId = String(ev.optionId ?? '')
      const sid = String(ev.sourceSessionId ?? '')
      const poll = ctx.polls[pollId]
      if (!poll || !sid || poll.voterSessions[sid]) {
        ctx.lastVote = null
        return
      }
      const option = poll.options.find((o) => o.id === optionId)
      if (!option) {
        ctx.lastVote = null
        return
      }
      option.count += 1
      poll.voterSessions[sid] = true
      ctx.lastVote = { pollId, sessionId: sid }
    },
  },

  selectors: {
    all: (ctx) =>
      Object.values(ctx.polls).sort((a, b) => b.createdAt - a.createdAt),
    byId: (ctx) => (id: string) => ctx.polls[id],
    totalCount: (ctx) => Object.keys(ctx.polls).length,
    totalVotes: (ctx) =>
      Object.values(ctx.polls).reduce(
        (s, p) => s + p.options.reduce((ss, o) => ss + o.count, 0),
        0,
      ),
    hasVoted: (ctx) => (pollId: string, sid: string) => {
      const poll = ctx.polls[pollId]
      return !!poll && !!poll.voterSessions[sid]
    },
  },
})
