import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { escapeXml, renderFeed } from '../lib/feed.ts'

/**
 * The RSS feed: the builder's escaping tested directly (signatures are
 * visitor-typed text), and the /feed.xml route end-to-end through a real
 * dev app — same BookMachine the page reads, different output plane.
 */

describe('feed rendering', () => {
  it('escapes visitor text so a signature cannot inject markup', () => {
    expect(escapeXml(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&apos;')
  })

  it('renders entries newest-first with RFC-822 dates and stable guids', () => {
    const xml = renderFeed(
      [
        { id: 'e2', name: 'Ketil', message: 'From a train.', signedAt: 86_400_000 },
        { id: 'e1', name: 'Marisol <3', message: 'Guestbooks & trains.', signedAt: 0 },
      ],
      'http://test',
    )
    expect(xml).toContain('<pubDate>Fri, 02 Jan 1970 00:00:00 GMT</pubDate>')
    expect(xml).toContain('<guid isPermaLink="false">e2</guid>')
    expect(xml).toContain('Marisol &lt;3 signed the book')
    expect(xml).toContain('Guestbooks &amp; trains.')
    expect(xml.indexOf('e2')).toBeLessThan(xml.indexOf('e1'))
  })
})

describe('the /feed.xml route', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  let app: import('@statorjs/stator/dev').DevApp

  beforeAll(async () => {
    const { createDevApp } = await import('@statorjs/stator/dev')
    app = await createDevApp({
      root: resolve(here, '..'),
      machinesDir: resolve(here, '../machines'),
      routesDir: resolve(here, '../routes'),
    })
  }, 30_000)

  afterAll(async () => {
    await app.close()
  })

  it('serves the book as application/xml, with a signature escaped', async () => {
    // Sign through the real form route so the entry takes the real path
    // (session SIGN → emit → BookMachine).
    const page = await app.fetch(new Request('http://test/'))
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!
    await app.fetch(
      new Request('http://test/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ name: 'Åse & Co', message: 'Hello <world>' }),
      }),
    )

    const res = await app.fetch(new Request('http://test/feed.xml'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xml')
    expect(res.headers.get('etag')).toBeTruthy()
    const xml = await res.text()
    expect(xml).toContain('Åse &amp; Co signed the book')
    expect(xml).toContain('Hello &lt;world&gt;')
    expect(xml).not.toContain('<world>')
  })
})
