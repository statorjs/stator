import { escapeHtml, renderContent } from './content.ts'
import type { PostRow } from './db.ts'
import { AUTHOR_NAME, SITE_NAME, SITE_ORIGIN, postUrl } from './site.ts'

/**
 * Feed builders — pure functions over the post list. Three formats because
 * readers are old and opinions are older: RSS 2.0, Atom, and JSON Feed. The
 * routes that serve them get strong ETags and bodyless 304s from the
 * framework, so polling readers cost almost nothing.
 */

function title(p: PostRow): string {
  return p.title ?? p.content.slice(0, 60).replace(/\s+\S*$/, '…')
}

export function renderRss(posts: PostRow[]): string {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${escapeHtml(title(p))}</title>
      <link>${escapeHtml(postUrl(p.slug))}</link>
      <guid>${escapeHtml(postUrl(p.slug))}</guid>
      <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
      <description>${escapeHtml(renderContent(p.content))}</description>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(SITE_NAME)}</title>
    <link>${escapeHtml(SITE_ORIGIN)}</link>
    <description>${escapeHtml(`${AUTHOR_NAME}'s site`)}</description>
${items}
  </channel>
</rss>
`
}

export function renderAtom(posts: PostRow[]): string {
  const updated = new Date(posts[0]?.updated_at ?? Date.now()).toISOString()
  const entries = posts
    .map(
      (p) => `  <entry>
    <title>${escapeHtml(title(p))}</title>
    <link href="${escapeHtml(postUrl(p.slug))}"/>
    <id>${escapeHtml(postUrl(p.slug))}</id>
    <updated>${new Date(p.updated_at).toISOString()}</updated>
    <content type="html">${escapeHtml(renderContent(p.content))}</content>
  </entry>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(SITE_NAME)}</title>
  <link href="${escapeHtml(SITE_ORIGIN)}"/>
  <id>${escapeHtml(`${SITE_ORIGIN}/`)}</id>
  <updated>${updated}</updated>
  <author><name>${escapeHtml(AUTHOR_NAME)}</name></author>
${entries}
</feed>
`
}

export function renderJsonFeed(posts: PostRow[]): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: SITE_NAME,
      home_page_url: `${SITE_ORIGIN}/`,
      feed_url: `${SITE_ORIGIN}/feed.json`,
      authors: [{ name: AUTHOR_NAME, url: `${SITE_ORIGIN}/` }],
      items: posts.map((p) => ({
        id: postUrl(p.slug),
        url: postUrl(p.slug),
        ...(p.title ? { title: p.title } : {}),
        content_html: renderContent(p.content),
        date_published: new Date(p.published_at).toISOString(),
        date_modified: new Date(p.updated_at).toISOString(),
      })),
    },
    null,
    2,
  )
}
