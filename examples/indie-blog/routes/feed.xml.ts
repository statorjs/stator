import { defineApiRoute } from '@statorjs/stator/server'
import { listPosts } from '../lib/db.ts'
import { renderRss } from '../lib/feed.ts'

// RSS 2.0 at /feed.xml — a data GET route: the extension names the content
// type, the framework stamps an ETag and answers If-None-Match with 304.
export const GET = defineApiRoute({
  method: 'GET',
  handler: () => renderRss(listPosts()),
})
