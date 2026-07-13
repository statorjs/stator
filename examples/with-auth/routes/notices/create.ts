import { defineApiRoute } from '@statorjs/stator/server'
import AuthMachine from '../../machines/auth.ts'

/** Posting: the form carries the CONTENT; the IDENTITY is stamped by
 *  AuthMachine's emit payload from its own context. This handler never
 *  sees or forwards a user id. */
export const POST = defineApiRoute({
  reads: [AuthMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    await dispatch(AuthMachine, {
      type: 'POST_NOTICE',
      title: String(form.get('title') ?? ''),
      body: String(form.get('body') ?? ''),
      membersOnly: form.get('membersOnly') === 'on',
    })
    return { directives: [{ type: 'navigate', to: '/' }] }
  },
})
