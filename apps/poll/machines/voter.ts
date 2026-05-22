import { defineMachine } from '@statorjs/stator/server'

type VoterContext = {
  /** Polls this session has voted in, mapped to the chosen optionId.
   *  Display only — the source of truth for "has this session voted"
   *  lives in PollsMachine.voterSessions, which is what gates double-voting. */
  votedIn: Record<string, string>
}

export default defineMachine({
  name: 'VoterMachine',
  lifecycle: 'session',
  reads: [],

  // Client events route to this machine first. Cross-machine subscriptions on
  // PollsMachine pick up the emits and update the shared state.
  emits: {
    POLL_CREATED: {
      payload: (_ctx: VoterContext, ev: { question: string; options: string[] }) => ({
        question: ev.question,
        options: ev.options,
      }),
    },
    VOTED: {
      payload: (_ctx: VoterContext, ev: { pollId: string; optionId: string }) => ({
        pollId: ev.pollId,
        optionId: ev.optionId,
      }),
    },
  },

  context: { votedIn: {} } as VoterContext,
  initial: 'idle',
  states: {
    idle: {
      on: {
        // Forwarded to PollsMachine via emit. We don't track creation here.
        CREATE_POLL: { emit: 'POLL_CREATED' },
        // Record the vote locally for UI purposes; the cross-machine subscription
        // on PollsMachine handles the authoritative count + dedup.
        VOTE: { actions: 'recordOwnVote', emit: 'VOTED' },
      },
    },
  },

  actions: {
    recordOwnVote: (ctx, ev) => {
      const pollId = String(ev.pollId ?? '')
      const optionId = String(ev.optionId ?? '')
      if (!pollId || !optionId) return
      if (ctx.votedIn[pollId]) return // already voted; ignore
      ctx.votedIn[pollId] = optionId
    },
  },

  selectors: {
    votedIn: (ctx) => ctx.votedIn,
    votedFor: (ctx) => (pollId: string) => ctx.votedIn[pollId] ?? null,
    hasVoted: (ctx) => (pollId: string) => pollId in ctx.votedIn,
    votedCount: (ctx) => Object.keys(ctx.votedIn).length,
  },
})
