import { defineRoute } from '@statorjs/stator/server'
import PollsMachine from '../../machines/polls.ts'
import VoterMachine from '../../machines/voter.ts'
import layout from '../../templates/layout.ts'
import pollPage from '../../templates/poll-page.ts'

export const GET = defineRoute({
  reads: [PollsMachine, VoterMachine],
  live: true,
  render: (
    { PollsMachine: polls, VoterMachine: voter }: any,
    request,
  ) =>
    layout(pollPage(polls, voter, request.params.id ?? '')),
})
