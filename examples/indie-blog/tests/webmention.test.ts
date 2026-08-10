import { describe, expect, it } from 'vitest'
import {
  classify,
  discoverEndpoint,
  mentionsTarget,
  requestError,
  sendMention,
} from '../lib/webmention.ts'

const ORIGIN = 'https://blog.example'
const TARGET = 'https://blog.example/posts/hello'

describe('requestError (the spec checks)', () => {
  it('rejects the malformed and the foreign', () => {
    expect(requestError(undefined, TARGET, ORIGIN)).toBeTruthy()
    expect(requestError('ftp://x', TARGET, ORIGIN)).toBeTruthy()
    expect(requestError(TARGET, TARGET, ORIGIN)).toBeTruthy()
    expect(requestError('https://a.dev/p', 'https://other.site/x', ORIGIN)).toBeTruthy()
    expect(requestError('https://a.dev/p', TARGET, ORIGIN)).toBeNull()
  })
})

describe('classify (microformats-lite)', () => {
  it('detects likes, reposts, and replies by mf2 class', () => {
    const like = `<a class="u-like-of" href="${TARGET}">nice</a>`
    const repost = `<a class="u-repost-of" href="${TARGET}">again</a>`
    const reply = `<div class="h-entry"><a class="u-in-reply-to" href="${TARGET}">re</a><p class="e-content">I agree with this a lot</p></div>`
    expect(classify(like, TARGET).kind).toBe('like')
    expect(classify(repost, TARGET).kind).toBe('repost')
    const r = classify(reply, TARGET)
    expect(r.kind).toBe('reply')
    expect(r.excerpt).toContain('I agree')
  })
  it('falls back to a plain mention with a title author', () => {
    const html = `<title>Someone's Site</title><a href="${TARGET}">link</a>`
    const m = classify(html, TARGET)
    expect(m.kind).toBe('mention')
    expect(m.authorName).toBe("Someone's Site")
  })
  it('reads the h-card author when present', () => {
    const html = `<div class="h-card"><span class="p-name">Marisol</span></div><a href="${TARGET}">x</a>`
    expect(classify(html, TARGET).authorName).toBe('Marisol')
  })
})

describe('mentionsTarget', () => {
  it('requires the target as an href', () => {
    expect(mentionsTarget(`<a href="${TARGET}">x</a>`, TARGET)).toBe(true)
    expect(mentionsTarget(`just the text ${TARGET}`, TARGET)).toBe(false)
  })
})

function fakeFetch(map: Record<string, { headers?: Record<string, string>; body?: string }>) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = String(url)
    const hit = map[key]
    if (!hit) return new Response('nope', { status: 404 })
    if (init?.method === 'POST') return new Response('ok', { status: 201 })
    return new Response(hit.body ?? '', { status: 200, headers: hit.headers ?? {} })
  }) as typeof fetch
}

describe('discoverEndpoint', () => {
  it('prefers the Link header', async () => {
    const f = fakeFetch({
      'https://t.dev/post': {
        headers: { link: '</webmention>; rel="webmention"' },
        body: 'irrelevant',
      },
    })
    expect(await discoverEndpoint('https://t.dev/post', f)).toBe('https://t.dev/webmention')
  })
  it('falls back to a body link rel, resolving relative hrefs', async () => {
    const f = fakeFetch({
      'https://t.dev/post': { body: '<link rel="webmention" href="/wm">' },
    })
    expect(await discoverEndpoint('https://t.dev/post', f)).toBe('https://t.dev/wm')
  })
  it('null when the target does not advertise one', async () => {
    const f = fakeFetch({ 'https://t.dev/post': { body: '<p>nothing here</p>' } })
    expect(await discoverEndpoint('https://t.dev/post', f)).toBeNull()
  })
})

describe('sendMention', () => {
  it('POSTs form-encoded source and target', async () => {
    let seen: string | null = null
    const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = String(init?.body)
      return new Response('', { status: 202 })
    }) as typeof fetch
    expect(await sendMention('https://t.dev/wm', 'https://me.dev/p', 'https://t.dev/post', f)).toBe(
      true,
    )
    expect(seen).toContain('source=https%3A%2F%2Fme.dev%2Fp')
  })
})
