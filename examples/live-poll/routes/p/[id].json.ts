import { defineApiRoute } from '@statorjs/stator/server'
import Polls, { type Poll } from '../../machines/polls.ts'

/** The poll's results as JSON — the data twin of the /p/[id] page. The
 *  [id].json.ts filename routes /p/:id.json beside the page's bare :id, so
 *  browsers watch the page over SSE while programs poll this URL (and get
 *  304s between votes — the framework stamps an ETag). voterSessions stays
 *  server-side: sessions are not public. */
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Polls],
  handler: (request, { machines }: any) => {
    const poll: Poll | undefined = machines.PollsMachine.byId(request.params.id)
    if (!poll) {
      return Response.json({ error: 'no such poll' }, { status: 404 })
    }
    return {
      id: poll.id,
      question: poll.question,
      createdAt: poll.createdAt,
      totalVotes: poll.options.reduce((sum, o) => sum + o.count, 0),
      options: poll.options.map((o) => ({ id: o.id, text: o.text, count: o.count })),
    }
  },
})
