import { defineApiRoute } from '../../../src/server/routing.ts'

/** A stylesheet as a data route: `/theme.css`, typed by the URL's extension. */
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => ':root { --accent: rebeccapurple; }',
})
