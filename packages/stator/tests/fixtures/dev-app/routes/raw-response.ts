import { defineApiRoute } from '@statorjs/stator/server'

// Returns a raw Response constructed inside a Vite-SSR-loaded module — the
// passthrough check must recognize it. A miss here silently reinterprets the
// Response as an empty {patches, directives} envelope.
export const POST = defineApiRoute({
  handler: () => Response.json({ ok: true, marker: 'raw-passthrough' }),
})
