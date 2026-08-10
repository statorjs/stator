import { defineMachine } from '@statorjs/stator/server'
import { postBySlug } from '../lib/db.ts'
import { SITE_ORIGIN, slugOfTarget } from '../lib/site.ts'
import { requestError } from '../lib/webmention.ts'

type ReceiverEvents = { type: 'RECEIVE'; id: string; source: string; target: string }

/**
 * The webmention endpoint's gateway — anonymous strangers POST here, so the
 * event lands in a throwaway session machine whose GUARD is the spec's
 * request validation: two http(s) URLs, target on this site, target names a
 * real post. Sessions can't dispatch into app machines; a guarded emit is
 * the door, and the wire can't forge its way past the guard.
 */
const ReceiverMachine = defineMachine({
  name: 'ReceiverMachine',
  lifecycle: 'session',
  events: {} as ReceiverEvents,

  emits: {
    MENTION_RECEIVED: {
      payload: (_ctx: Record<string, never>, ev: { id: string; source: string; target: string }) => ({
        id: ev.id,
        source: ev.source,
        target: ev.target,
        postSlug: slugOfTarget(ev.target) ?? '',
      }),
    },
  },

  context: {},
  initial: 'open',
  states: {
    open: {
      on: {
        RECEIVE: {
          when: (_ctx, ev) => {
            if (requestError(ev.source, ev.target, SITE_ORIGIN) !== null) return false
            const slug = slugOfTarget(ev.target)
            return slug !== null && postBySlug(slug) !== null
          },
          emit: 'MENTION_RECEIVED',
        },
      },
    },
  },

  selectors: {},
})

export default ReceiverMachine
