import { defineMachine } from '@statorjs/stator/machine'

type VoterContext = {
  /** Polls this session has voted in, mapped to the chosen option's id. For
   *  display: the rule that refuses a second vote is PollsMachine's. */
  votedIn: Record<string, string>
}

type VoterEvents =
  | { type: 'CREATE_POLL'; question: string; options: string[] }
  | { type: 'VOTE'; pollId: string; optionId: string }

/**
 * The session's side of the polls: the gateway a browser's events pass
 * through on their way to the shared PollsMachine. Each handler emits, and
 * PollsMachine subscribes.
 */
export default defineMachine({
  name: 'VoterMachine',
  lifecycle: 'session',
  events: {} as VoterEvents,
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
        CREATE_POLL: { emit: 'POLL_CREATED' },
        VOTE: {
          // The event's type says strings, but what arrives is JSON from a
          // browser: check before using a field as a key. A refused event
          // emits nothing and reports `committed: false`.
          when: (ctx, ev) =>
            typeof ev.pollId === 'string' &&
            typeof ev.optionId === 'string' &&
            !Object.hasOwn(ctx.votedIn, ev.pollId),
          do: (ctx, ev) => {
            ctx.votedIn[ev.pollId] = ev.optionId
          },
          emit: 'VOTED',
        },
      },
    },
  },
  selectors: {
    votedFor: (ctx) => (pollId: string): string | null => ctx.votedIn[pollId] ?? null,
  },
})
