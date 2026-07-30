import { defineApiRoute } from '@statorjs/stator/server'
import { renderFeed } from '../lib/feed.ts'
import Book from '../machines/book.ts'

// A data GET route: the file's .xml names the URL (/feed.xml) and the string
// return takes application/xml from it. Same BookMachine the live page
// reads — browsers get SSE pushes, feed readers get conditional GETs (the
// framework stamps an ETag and answers If-None-Match with 304).
export const GET = defineApiRoute({
  method: 'GET',
  reads: [Book],
  handler: (request, { machines }: any) =>
    renderFeed(machines.BookMachine.entries, new URL(request.url).origin),
})
