import { defineApiRoute } from '@statorjs/stator/server'

// Static sibling of the catch-all: specificity says this wins /files/pinned.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ({ pinned: true }),
})
