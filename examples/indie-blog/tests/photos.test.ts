import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const PORT = 3909
process.env.INDIE_BLOG_DB = join(mkdtempSync(join(tmpdir(), 'indie-photos-')), 'test.db')
process.env.INDIE_BLOG_MEDIA = mkdtempSync(join(tmpdir(), 'indie-media-'))
process.env.INDIE_BLOG_ORIGIN = `http://localhost:${PORT}`

let app: import('@statorjs/stator/dev').DevApp
const base = `http://localhost:${PORT}`

// A real 1x1 PNG — the smallest honest image bytes.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

before(async () => {
  const { createDevApp } = await import('@statorjs/stator/dev')
  const { resetDb } = await import('../lib/db.ts')
  resetDb()
  const here = new URL('..', import.meta.url).pathname
  app = await createDevApp({
    root: here,
    machinesDir: join(here, 'machines'),
    routesDir: join(here, 'routes'),
    staticDir: join(here, 'static'),
    // In-process boots don't read stator.config.ts (the CLI loads it) — pass
    // the images config the way the config file does.
    images: { dir: process.env.INDIE_BLOG_MEDIA as string, path: '/media' },
  })
  await app.listen(PORT)
}, { timeout: 30_000 })

after(async () => {
  await app?.close()
})

function sidOf(res: Response): string | null {
  return res.headers.get('set-cookie')?.match(/stator_sid=([^;]+)/)?.[1] ?? null
}

async function publish(sid: string, fields: Record<string, string>, photo?: File) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  if (photo) form.set('photo', photo)
  const res = await fetch(`${base}/admin/publish`, {
    method: 'POST',
    headers: { Cookie: `stator_sid=${sid}` },
    body: form, // multipart — the boundary content-type is set by fetch
    redirect: 'manual',
  })
  return (await res.json()) as { directives?: Array<{ type: string; to: string }> }
}

let sid: string

describe('photo posts over multipart', () => {

  before(async () => {
    const first = await fetch(`${base}/admin`)
    sid = sidOf(first)!
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `stator_sid=${sid}`,
      },
      body: new URLSearchParams({ password: 'owls-at-dusk' }),
      redirect: 'manual',
    })
    // Login rotates the session (fixation protection) — adopt the new id.
    sid = sidOf(login) ?? sid
  })

  it('publishes a photo post: kind, u-photo markup, media served with a 304 revalidator', async () => {
    const photo = new File([PNG], 'harbor.png', { type: 'image/png' })
    const result = await publish(sid, { title: '', content: 'Harbor at dusk.', photo_alt: 'A harbor at dusk' }, photo)
    const to = result.directives?.[0]?.to
    assert.ok(to)
    assert.match(to, /^\/posts\//)

    const html = await (await fetch(`${base}${to}`)).text()
    assert.ok(html.includes('class="u-photo"'))
    const src = html.match(/src="(\/media\/[^"]+)"/)?.[1]
    assert.ok(src)
    assert.match(src, /^\/media\/\d{4}\/\d{2}\/.+\.png$/)
    assert.ok(html.includes('alt="A harbor at dusk"'))

    const media = await fetch(`${base}${src}`)
    assert.equal(media.status, 200)
    assert.equal(media.headers.get('content-type'), 'image/png')
    const etag = media.headers.get('etag')
    assert.ok(etag)
    const revalidated = await fetch(`${base}${src}`, { headers: { 'If-None-Match': etag! } })
    assert.equal(revalidated.status, 304)

    // Intrinsic dimensions were probed at upload and rendered for CLS.
    assert.match(html, /width="1"[^>]*height="1"|height="1"[^>]*width="1"/)

    // The URL's extension is the delivery format: request the stored PNG as
    // webp and the endpoint transcodes. An off-allowlist width is a 400.
    const webp = await fetch(`${base}${src!.replace(/\.png$/, '.webp')}?w=400`)
    assert.equal(webp.status, 200)
    assert.equal(webp.headers.get('content-type'), 'image/webp')
    assert.equal((await fetch(`${base}${src}?w=999`)).status, 400)
  })

  it('rejects a photo without alt text', async () => {
    const photo = new File([PNG], 'x.png', { type: 'image/png' })
    const result = await publish(sid, { title: '', content: 'No alt.', photo_alt: '' }, photo)
    assert.equal(result.directives?.[0]?.to, '/admin?error=photo-alt')
  })

  it('a media path that escapes the dir or has no known extension 404s', async () => {
    assert.equal((await fetch(`${base}/media/../../etc/passwd`)).status, 404)
    assert.equal((await fetch(`${base}/media/2026/08/nope.txt`)).status, 404)
  })

  it('a plain urlencoded publish still works (no photo entry at all)', async () => {
    const result = await publish(sid, { title: 'Words', content: 'Just words.', photo_alt: '' })
    const to = result.directives?.[0]?.to
    assert.ok(to)
    assert.match(to, /^\/posts\/words/)
  })
})

describe('compose draft recovery', () => {
  it('a validation bounce keeps the typed fields; a successful publish clears them', async () => {
    const photo = new File([PNG], 'x.png', { type: 'image/png' })
    await publish(sid, { title: 'Draft Title', content: 'Typed words.', photo_alt: '' }, photo)
    const bounced = await (
      await fetch(`${base}/admin`, { headers: { Cookie: `stator_sid=${sid}` } })
    ).text()
    assert.ok(bounced.includes('value="Draft Title"'))
    assert.ok(bounced.includes('re-pick your file'))
    // The textarea pre-fill must be RAW text — a live-slot wrapper inside
    // RCDATA renders as literal markup (the bug that shipped first).
    const textarea = bounced.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? ''
    assert.ok(textarea.includes('Typed words.'))
    assert.ok(!textarea.includes('data-slot'))

    await publish(sid, { title: 'Draft Title', content: 'Typed words.', photo_alt: 'alt' }, photo)
    const after = await (
      await fetch(`${base}/admin`, { headers: { Cookie: `stator_sid=${sid}` } })
    ).text()
    assert.ok(!after.includes('value="Draft Title"'))
  })
})
