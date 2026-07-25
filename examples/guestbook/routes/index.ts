import { defineApiRoute } from '@statorjs/stator/server'
import { cleanSignature, MAX_MESSAGE } from '../lib/rules.ts'
import VisitorMachine from '../machines/visitor.ts'

/** POST half of / — merges with index.stator's GET at the same URL.
 *  A plain form post: parse, bounce obviously-bad input back with a friendly
 *  error, and dispatch SIGN. The machines re-apply the rules on their side —
 *  this handler is the doorman, not the law. */
export const POST = defineApiRoute({
  reads: [VisitorMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const name = String(form.get('name') ?? '')
    const message = String(form.get('message') ?? '')

    if (!cleanSignature(name, message)) {
      const why = !name.trim() ? 'name' : message.trim().length > MAX_MESSAGE ? 'long' : 'empty'
      return { directives: [{ type: 'navigate', to: `/?error=${why}` }] }
    }

    await dispatch(VisitorMachine, { type: 'SIGN', name, message })
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
