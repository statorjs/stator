import { defineMachine } from '@statorjs/stator/server'

type VoterContext = {
  /** Polls this session has voted in, mapped to the chosen optionId.
   *  Display only — the source of truth for "has this session voted"
   *  lives in PollsMachine.voterSessions, which is what gates double-voting. */
  votedIn: Record<string, string>
}

type VoterEvents =
  | { type: 'CREATE_POLL'; question: string; options: string[] }
  | { type: 'VOTE'; pollId: string; optionId: string }

export default defineMachine({
  name: 'VoterMachine',
  lifecycle: 'session',
  events: {} as VoterEvents,

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
        VOTE: {
          do: (ctx, ev) => {
            if (!ev.pollId || !ev.optionId) return
            if (ctx.votedIn[ev.pollId]) return // already voted; ignore
            ctx.votedIn[ev.pollId] = ev.optionId
          },
          emit: 'VOTED',
        },
      },
    },
  },

  selectors: {
    votedIn: (ctx) => ctx.votedIn,
    votedFor: (ctx) => (pollId: string) => ctx.votedIn[pollId] ?? null,
    hasVoted: (ctx) => (pollId: string) => pollId in ctx.votedIn,
    votedCount: (ctx) => Object.keys(ctx.votedIn).length,
  },
})
