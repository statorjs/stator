import { defineRoute } from '../../../../src/server/routing.ts'
import { defer } from '../../../../src/template/defer.ts'
import { html } from '../../../../src/template/html.ts'
import { read } from '../../../../src/template/read.ts'
import Pinger from '../machines/pinger.ts'

// A machine read() inside a defer arm — the illegal pattern. The runtime guard
// (registerBinding under deferDepth>0) throws when the arm renders, so the GET
// fails rather than silently freezing the value.
export const GET = defineRoute({
  reads: [Pinger],
  render: ({ Pinger: p }: any) => html`
    <main>
      ${defer(() => 'x', { ready: () => html`<span>${read(p, (s) => s.pings)}</span>` })}
    </main>
  `,
})
