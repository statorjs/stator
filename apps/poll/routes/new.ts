import { defineApiRoute, defineRoute } from '@statorjs/stator/server'
import VoterMachine from '../machines/voter.ts'
import layout from '../templates/layout.ts'
import newPollPage from '../templates/new-poll-page.ts'

export const GET = defineRoute({
  reads: [VoterMachine],
  render: () => layout(newPollPage()),
})

export const POST = defineApiRoute({
  reads: [VoterMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const question = String(form.get('question') ?? '').trim()
    const options = form
      .getAll('option')
      .map((v) => String(v).trim())
      .filter((o) => o.length > 0)

    if (!question || options.length < 2) {
      return {
        directives: [{ type: 'navigate', to: '/new?error=missing' }],
      }
    }

    // VoterMachine emits POLL_CREATED, which PollsMachine subscribes to.
    // The framework's cross-machine subscription path runs the actual
    // create transition there. Dispatch is addressed by the imported machine
    // def (no magic string); the event is typed against VoterMachine's events.
    await dispatch(VoterMachine, {
      type: 'CREATE_POLL',
      question,
      options,
    })

    return {
      directives: [{ type: 'navigate', to: '/' }],
    }
  },
})
