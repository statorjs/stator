import type { Entry } from '../machines/book.ts'

/** Entry names and messages are visitor-typed text — everything interpolated
 *  into the XML must be escaped or a signature could inject markup into
 *  every subscriber's reader. */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** RSS 2.0 for the book's latest signatures, newest first (the machine
 *  already keeps them that way). `siteUrl` is the request's own origin, so
 *  the feed links to wherever it is actually served from. */
export function renderFeed(entries: Entry[], siteUrl: string): string {
  const items = entries
    .map(
      (e) => `    <item>
      <title>${escapeXml(e.name)} signed the book</title>
      <link>${escapeXml(siteUrl)}/</link>
      <guid isPermaLink="false">${escapeXml(e.id)}</guid>
      <pubDate>${new Date(e.signedAt).toUTCString()}</pubDate>
      <description>${escapeXml(e.message)}</description>
    </item>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Guestbook · Stator</title>
    <link>${escapeXml(siteUrl)}/</link>
    <description>The latest signatures in the book</description>
${items}
  </channel>
</rss>
`
}
