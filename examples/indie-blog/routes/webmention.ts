import { defineApiRoute } from '@statorjs/stator/server'
import { genId } from '../lib/db.ts'
import { SITE_ORIGIN } from '../lib/site.ts'
import { requestError } from '../lib/webmention.ts'
import ReceiverMachine from '../machines/receiver.ts'

/**
 * The webmention endpoint (https://www.w3.org/TR/webmention/). Anonymous by
 * design — the RECEIVE event's guard IS the request validation, and a
 * committed dispatch means the mention entered the verification pipeline.
 * Processing is async per spec, so success is 202 Accepted; verification,
 * classification, and moderation all happen behind it.
 */
export const POST = defineApiRoute({
  reads: [ReceiverMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData().catch(() => null)
    const source = form?.get('source')
    const target = form?.get('target')
    const bad = requestError(source, target, SITE_ORIGIN)
    if (bad) return new Response(bad, { status: 400 })

    const { committed } = await dispatch(ReceiverMachine, {
      type: 'RECEIVE',
      id: genId(),
      source: String(source),
      target: String(target),
    })
    // A guard drop past basic validation means the target isn't a real post.
    if (!committed) return new Response('target not found', { status: 400 })
    return new Response('accepted', { status: 202 })
  },
})
