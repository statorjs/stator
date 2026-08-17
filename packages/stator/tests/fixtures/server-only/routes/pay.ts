import { defineRoute } from '../../../../src/server/routing.ts'
import { html } from '../../../../src/template/html.ts'
import PayMachine from '../machines/pay.ts'

// Reading PayMachine pulls it into the runtime graph so /__events can address
// it. In a page render the machine proxy is on the ctx keyed by name (the same
// binding `Stator.reads([PayMachine])` yields in a `.stator` frontmatter).
export const GET = defineRoute({
  reads: [PayMachine],
  render: (ctx) => {
    // Page-render ctx is loose (`Record<string, unknown>`) — real routes are
    // `.stator` files the compiler types; a hand-written fixture casts.
    const pay = ctx.PayMachine as { status: string }
    return html`<!doctype html><html><body><p>Status: <span>${pay.status}</span></p></body></html>`
  },
})
