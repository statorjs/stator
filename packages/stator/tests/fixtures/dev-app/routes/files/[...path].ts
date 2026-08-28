import { defineApiRoute } from '@statorjs/stator/server'

// Catch-all fixture: `[...path]` matches zero or more segments; the param is
// the raw remainder ('' when nothing follows /files).
export const GET = defineApiRoute({
  method: 'GET',
  handler: (request) => ({ path: request.params.path }),
})
