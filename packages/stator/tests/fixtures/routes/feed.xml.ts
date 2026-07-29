import { defineApiRoute } from '../../../src/server/routing.ts'

// Extension-named data route: serves /feed.xml, and the string return takes
// its Content-Type from the URL's extension.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => '<?xml version="1.0"?><rss><channel><title>fixture</title></channel></rss>',
})
