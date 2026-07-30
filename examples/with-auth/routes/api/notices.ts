import { defineApiRoute } from '@statorjs/stator/server'
import AuthMachine from '../../machines/auth.ts'
import BoardMachine, { type Notice } from '../../machines/board.ts'

/** The board as JSON — the API twin of the home page. The viewer's session
 *  decides what the one URL returns: identity comes from the cookie's own
 *  AuthMachine, never from the request, so there is nothing to forge.
 *  Members-only notices are filtered server-side exactly like the page —
 *  absent from the body, not hidden in it. Consequence worth knowing:
 *  bodies (and ETags) vary per viewer, so a shared cache in front of this
 *  URL must treat it as private. */
export const GET = defineApiRoute({
  method: 'GET',
  reads: [AuthMachine, BoardMachine],
  handler: (_request, { machines }: any) => {
    const member: boolean = machines.AuthMachine.isAuthenticated
    return {
      viewer: member ? 'member' : 'visitor',
      notices: machines.BoardMachine.visibleTo(member).map((n: Notice) => ({
        id: n.id,
        author: n.authorName,
        title: n.title,
        body: n.body,
        pinned: n.pinned,
        postedAt: n.postedAt,
      })),
    }
  },
})
