/**
 * Webmention plumbing — pure-ish functions the machines' effects call.
 * Implemented from the spec (https://www.w3.org/TR/webmention/), simplified
 * where a personal site can afford it, and tested at the parsing seams.
 */

export type MentionKind = 'like' | 'repost' | 'reply' | 'mention'

export interface VerifiedMention {
  kind: MentionKind
  authorName: string
  authorUrl: string | null
  /** First ~200 chars of the source's e-content, plain text, for replies. */
  excerpt: string | null
}

/** A webmention request is two absolute http(s) URLs, source ≠ target, and
 *  the target must be a URL this site serves. Returns an error string or null. */
export function requestError(source: unknown, target: unknown, siteOrigin: string): string | null {
  if (typeof source !== 'string' || typeof target !== 'string') {
    return 'source and target are required'
  }
  if (!isHttpUrl(source) || !isHttpUrl(target)) return 'source and target must be http(s) URLs'
  if (source === target) return 'source and target must differ'
  if (!target.startsWith(siteOrigin)) return 'target is not on this site'
  return null
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Verification, per spec: fetch the source and confirm it actually links to
 * the target. Classification is microformats-lite — enough for likes,
 * reposts, and replies from mf2-marked-up sites, falling back to a plain
 * mention. (A full mf2 parser is deliberately out of scope for the starter.)
 */
export async function verifySource(
  source: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedMention | null> {
  const res = await fetchImpl(source, {
    headers: { accept: 'text/html', 'user-agent': 'indie-blog-webmention' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const html = (await res.text()).slice(0, 500_000)
  if (!mentionsTarget(html, target)) return null
  return classify(html, target)
}

/** The spec's one hard requirement: the source document must contain the
 *  target URL as a link. */
export function mentionsTarget(html: string, target: string): boolean {
  return html.includes(`href="${target}"`) || html.includes(`href='${target}'`)
}

export function classify(html: string, target: string): VerifiedMention {
  const kind: MentionKind = hasMf2Link(html, 'u-like-of', target)
    ? 'like'
    : hasMf2Link(html, 'u-repost-of', target)
      ? 'repost'
      : hasMf2Link(html, 'u-in-reply-to', target) || hasMf2Link(html, 'in-reply-to', target)
        ? 'reply'
        : 'mention'
  const authorName = firstMf2Text(html, 'p-name', 'h-card') ?? firstTitle(html) ?? 'Someone'
  const authorUrl = firstMf2Href(html, 'u-url')
  const excerpt = kind === 'reply' ? (firstMf2Text(html, 'e-content') ?? null) : null
  return { kind, authorName, authorUrl, excerpt: excerpt ? excerpt.slice(0, 200) : null }
}

/** Does an anchor carrying `cls` link to the target? */
function hasMf2Link(html: string, cls: string, target: string): boolean {
  const re = /<a\s[^>]*>/gi
  for (const m of html.matchAll(re)) {
    const tag = m[0]
    if (!tag.includes(target)) continue
    const classAttr = /class=["']([^"']*)["']/.exec(tag)?.[1] ?? ''
    if (classAttr.split(/\s+/).includes(cls)) return true
  }
  return false
}

function firstMf2Text(html: string, cls: string, withinCls?: string): string | null {
  const scope = withinCls ? scopeOf(html, withinCls) : html
  const re = new RegExp(`class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([^<]{1,300})<`, 'i')
  const m = re.exec(scope)
  return m ? m[1]!.trim() : null
}

function firstMf2Href(html: string, cls: string): string | null {
  const re = new RegExp(`<a\\s[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*href=["']([^"']+)["']`, 'i')
  const alt = new RegExp(`<a\\s[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\\b${cls}\\b[^"']*["']`, 'i')
  return re.exec(html)?.[1] ?? alt.exec(html)?.[1] ?? null
}

function scopeOf(html: string, cls: string): string {
  const at = html.search(new RegExp(`class=["'][^"']*\\b${cls}\\b`))
  return at === -1 ? html : html.slice(at, at + 2000)
}

function firstTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,120})</i.exec(html)
  return m ? m[1]!.trim() : null
}

/**
 * Endpoint discovery for SENDING, per spec: a Link header with
 * rel="webmention" wins, then the first <link>/<a> with that rel in the
 * body. Returns an absolute URL or null if the target doesn't accept
 * webmentions.
 */
export async function discoverEndpoint(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(target, {
    headers: { accept: 'text/html', 'user-agent': 'indie-blog-webmention' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const header = res.headers.get('link')
  if (header) {
    const m = /<([^>]+)>\s*;[^,]*rel=["']?(?:[^"',]*\s)?webmention(?:\s[^"',]*)?["']?/i.exec(header)
    if (m) return new URL(m[1]!, res.url || target).href
  }
  const html = (await res.text()).slice(0, 500_000)
  const m =
    /<(?:link|a)\s[^>]*rel=["'](?:[^"']*\s)?webmention(?:\s[^"']*)?["'][^>]*href=["']([^"']*)["']/i.exec(html) ??
    /<(?:link|a)\s[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:[^"']*\s)?webmention(?:\s[^"']*)?["']/i.exec(html)
  return m ? new URL(m[1]!, res.url || target).href : null
}

/** POST the mention to a discovered endpoint. True on any 2xx. */
export async function sendMention(
  endpoint: string,
  source: string,
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ source, target }),
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}
