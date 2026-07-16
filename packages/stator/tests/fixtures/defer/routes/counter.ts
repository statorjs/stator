import { defineRoute } from '../../../../src/server/routing.ts'
import { defer } from '../../../../src/template/defer.ts'
import { html } from '../../../../src/template/html.ts'
import { bumpDeferKicks } from '../kick-count.ts'
import Pinger from '../machines/pinger.ts'

// Reads Pinger so a PING can be POSTed against this route. The defer thunk bumps
// a module counter: it must fire once on the cold GET and never on the /__events
// re-diff (which renders the baseline under the lock with resolveDeferred=false).
export const GET = defineRoute({
  reads: [Pinger],
  render: () => html`
    <main>
      ${defer(
        () => {
          bumpDeferKicks()
          return 'loaded'
        },
        { ready: (v) => html`<p>${v}</p>` },
      )}
    </main>
  `,
})
