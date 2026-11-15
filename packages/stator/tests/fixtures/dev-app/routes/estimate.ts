import { defineApiRoute } from '@statorjs/stator/server'
import estimates from '../lib/estimates.json' with { type: 'json' }

/** A JSON import with an import attribute: the dev loader must keep it. */
export const GET = defineApiRoute({
  method: 'GET',
  handler: (request) => {
    const zip = String(request.query.zip ?? '35640')
    return { zip, estimate: (estimates as Record<string, number>)[zip] ?? null }
  },
})
