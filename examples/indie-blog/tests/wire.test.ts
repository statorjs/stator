import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'


/**
 * The whole loop over the wire — including the blog webmentioning ITSELF:
 * post B links to post A, the endpoint accepts, the verification effect
 * fetches B's real page over a listening port, finds the link, and the
 * mention flows through moderation to A's page. One process, no mocks.
 */

const PORT = 3907
process.env.INDIE_BLOG_DB = join(mkdtempSync(join(tmpdir(), 'indie-wire-')), 'test.db')
process.env.INDIE_BLOG_ORIGIN = `http://localhost:${PORT}`

const here = dirname(fileURLToPath(import.meta.url))
let app: import('@statorjs/stator/dev').DevApp

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  app = await createDevApp({
    root: resolve(here, '..'),
    machinesDir: resolve(here, '../machines'),
    routesDir: resolve(here, '../routes'),
    staticDir: resolve(here, '../static'),
  })
  await app.listen(PORT)
}, { timeout: 30_000 })

after(async () => {
  await app.close()
})

const base = `http://localhost:${PORT}`

function sidOf(res: Response): string | null {
  return res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1] ?? null
}

async function postForm(path: string, sid: string, fields: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `stator_sid=${sid}`,
    },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  })
}

async function postEvent(sid: string, machine: string, event: object) {
  const res = await fetch(`${base}/__events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stator-Route': 'GET /admin',
      Cookie: `stator_sid=${sid}`,
    },
    body: JSON.stringify({ machine, event }),
  })
  return (await res.json()) as { committed: boolean }
}

async function page(path: string, sid?: string): Promise<string> {
  const res = await fetch(`${base}${path}`, {
    headers: sid ? { Cookie: `stator_sid=${sid}` } : {},
  })
  return res.text()
}

async function until(check: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe('the indie-blog loop', () => {
  let sid: string

  before(async () => {
    sid = sidOf(await fetch(`${base}/`))!
  })

  it('serves the empty front page with feed + webmention advertisement', async () => {
    const html = await page('/')
    assert.ok(html.includes('rel="webmention"'))
    assert.ok(html.includes('href="/feed.xml"'))
    assert.ok(html.includes('h-feed'))
  })

  it('rejects publishing while signed out', async () => {
    const res = await postForm('/admin/publish', sid, { title: '', content: 'sneaky' })
    assert.ok((await res.text()).includes('not-signed-in'))
  })

  it('signs in with the owner password (wrong one bounces)', async () => {
    const bad = await postForm('/admin/login', sid, { password: 'nope' })
    assert.ok((await bad.text()).includes('bad-password'))
    const good = await postForm('/admin/login', sid, { password: 'owls-at-dusk' })
    const rotated = sidOf(good)
    assert.ok(rotated)
    assert.notEqual(rotated, sid)
    sid = rotated!
  })

  it('publishes an article and a note; the pages carry microformats', async () => {
    await postForm('/admin/publish', sid, {
      title: 'Hello World',
      content: 'The first post.\n\nIt has two paragraphs.',
    })
    const post = await page('/posts/hello-world')
    assert.ok(post.includes('h-entry'))
    assert.ok(post.includes('dt-published'))
    assert.ok(post.includes('two paragraphs'))

    const home = await page('/')
    assert.ok(home.includes('Hello World'))
  })

  it('serves all three feeds, ETagged', async () => {
    const rss = await fetch(`${base}/feed.xml`)
    assert.equal(rss.status, 200)
    assert.ok((await rss.text()).includes('<rss'))
    const etag = rss.headers.get('etag')
    assert.ok(etag)
    const conditional = await fetch(`${base}/feed.xml`, {
      headers: { 'if-none-match': etag! },
    })
    assert.equal(conditional.status, 304)
    assert.equal((await fetch(`${base}/atom.xml`)).status, 200)
    const json = await (await fetch(`${base}/feed.json`)).json()
    assert.ok(json.items[0].url.includes('/posts/hello-world'))
  })

  it('refuses malformed and foreign webmentions', async () => {
    const missing = await fetch(`${base}/webmention`, { method: 'POST', body: new URLSearchParams({}) })
    assert.equal(missing.status, 400)
    const foreign = await fetch(`${base}/webmention`, {
      method: 'POST',
      body: new URLSearchParams({
        source: 'https://a.dev/x',
        target: 'https://not-this-site.dev/posts/hello-world',
      }),
    })
    assert.equal(foreign.status, 400)
    const noSuchPost = await fetch(`${base}/webmention`, {
      method: 'POST',
      body: new URLSearchParams({
        source: 'https://a.dev/x',
        target: `${base}/posts/never-was`,
      }),
    })
    assert.equal(noSuchPost.status, 400)
  })

  it('the blog webmentions itself: reply post → verify over the real port → moderate → live on the page', async () => {
    // Post B links to A — publishing it also queues an OUTBOX entry for A.
    await postForm('/admin/publish', sid, {
      title: '',
      content: `Replying to ${base}/posts/hello-world with enthusiasm.`,
    })
    const home = await page('/')
    const noteSlug = /href="\/posts\/(replying-to[^"]*)"/.exec(home)?.[1]
    assert.ok(noteSlug)

    // Send the mention: B is the source, A the target.
    const accepted = await fetch(`${base}/webmention`, {
      method: 'POST',
      body: new URLSearchParams({
        source: `${base}/posts/${noteSlug}`,
        target: `${base}/posts/hello-world`,
      }),
    })
    assert.equal(accepted.status, 202)

    // Verification fetches B's real page and finds the autolinked target.
    const verified = await until(async () =>
      (await page('/admin', sid)).includes('APPROVE_MENTION'),
    )
    assert.equal(verified, true)

    // Approve it through the owner machine (typed event over the wire).
    const id = /"id":"([a-z0-9]+)"/.exec(
      /APPROVE_MENTION[^}]*}/.exec((await page('/admin', sid)).replaceAll('&quot;', '"'))?.[0] ?? '',
    )?.[1]
    assert.ok(id)
    assert.equal((await postEvent(sid, 'OwnerMachine', { type: 'APPROVE_MENTION', id })).committed, true)

    // The approved mention shows on A's page as a plain-mention row.
    const post = await page('/posts/hello-world')
    assert.ok(post.includes('mentions ·'))
    assert.ok(post.includes(`/posts/${noteSlug}`))
  })

  it('the outbox recorded the self-send workflow', async () => {
    const admin = await page('/admin', sid)
    assert.ok(admin.includes('outbox'))
    assert.match(admin, /replying-to[^<]*→/)
  })
})
