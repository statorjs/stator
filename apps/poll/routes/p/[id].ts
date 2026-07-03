import { defineRoute } from '@statorjs/stator/server'
import PollsMachine from '../../machines/polls.ts'
import VoterMachine from '../../machines/voter.ts'
import layout from '../../templates/layout.ts'
import pollPage from '../../templates/poll-page.ts'

export const GET = defineRoute({
  reads: [PollsMachine, VoterMachine],
  live: true,
  // biome-ignore lint/suspicious/noExplicitAny: the old-style route API's render ctx is untyped; this app is slated for the .stator rewrite (0.9 work list)
  render: ({ PollsMachine: polls, VoterMachine: voter }: any, request) =>
    layout(pollPage(polls, voter, request.params.id ?? '')),
})
