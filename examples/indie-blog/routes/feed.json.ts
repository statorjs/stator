import { defineApiRoute } from '@statorjs/stator/server'
import { listPosts } from '../lib/db.ts'
import { renderJsonFeed } from '../lib/feed.ts'

export const GET = defineApiRoute({
  method: 'GET',
  handler: () => renderJsonFeed(listPosts()),
})
