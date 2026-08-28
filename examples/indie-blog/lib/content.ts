/**
 * Content rules — pure functions, tested, no framework imports.
 *
 * Post-type discovery, simplified from the W3C algorithm the IndieWeb uses:
 * a post with a photo is a photo, named content is an article, unnamed
 * content is a note. (The full algorithm also checks replies and likes —
 * add branches as your posts grow kinds.)
 */

import type { PostKind } from './db.ts'

export function discoverKind(title: string, _content: string, hasPhoto = false): PostKind {
  if (hasPhoto) return 'photo'
  return title.trim() === '' ? 'note' : 'article'
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '')
  return base === '' ? `post-${Date.now().toString(36)}` : base
}

export function contentError(value: string): string | null {
  if (value.trim() === '') return 'A post needs some content.'
  if (value.length > 20_000) return 'Posts fit in 20,000 characters.'
  return null
}

/** Split plain text into paragraphs and autolink bare URLs. Returns HTML
 *  strings whose TEXT segments are escaped — safe to render with raw(). */
export function renderContent(text: string): string {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  return paragraphs.map((p) => `<p>${autolink(p.trim())}</p>`).join('\n')
}

const URL_RE = /https?:\/\/[^\s<>"')]+/g

function autolink(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    out += escapeHtml(text.slice(last, m.index))
    const url = m[0]
    out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
    last = m.index + url.length
  }
  out += escapeHtml(text.slice(last))
  return out
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Every http(s) URL in a post's content — the webmention targets of an
 *  outgoing post, before the configured syndication endpoints are added. */
export function outboundLinks(text: string): string[] {
  return [...new Set([...text.matchAll(URL_RE)].map((m) => m[0]))]
}
