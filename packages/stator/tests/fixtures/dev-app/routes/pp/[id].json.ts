import { defineApiRoute } from '@statorjs/stator/server'

// A dynamic segment WITH an extension suffix: [id].json.ts → /pp/:id.json.
// The captured param excludes the literal suffix.
export const GET = defineApiRoute({
  method: 'GET',
  handler: (request) => ({ id: request.params.id }),
})
