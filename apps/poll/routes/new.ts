import { defineApiRoute } from '@statorjs/stator/server'
import VoterMachine from '../machines/voter.ts'

/** POST half of /new — merges with new.stator's GET at the same URL.
 *  Parses the form, dispatches CREATE_POLL (VoterMachine emits POLL_CREATED,
 *  which PollsMachine subscribes to), returns a navigate directive. */
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
