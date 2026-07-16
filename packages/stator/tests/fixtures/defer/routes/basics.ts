import { defineRoute } from '../../../../src/server/routing.ts'
import { defer } from '../../../../src/template/defer.ts'
import { html } from '../../../../src/template/html.ts'

// Sync, async, and rejecting defers on one page — all resolve in parallel and
// render complete HTML inline (v1 blocking, no placeholder reaches the browser).
export const GET = defineRoute({
  reads: [],
  render: () => html`
    <main>
      ${defer(() => 'SYNC-VALUE', { ready: (v) => html`<p id="sync">${v}</p>` })}
      ${defer(() => Promise.resolve('ASYNC-VALUE'), {
        ready: (v) => html`<p id="async">${v}</p>`,
      })}
      ${defer(() => Promise.reject(new Error('boom')), {
        ready: () => html`<p id="err">unexpected</p>`,
        error: () => html`<p id="err">ERROR-ARM</p>`,
      })}
    </main>
  `,
})
