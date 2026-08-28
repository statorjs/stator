import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// In-process dev app needs the transitional Vite server (see wire.test.ts).
process.env.STATOR_VITE_DEV = '1'

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

beforeAll(async () => {
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
}, 30_000)

afterAll(async () => {
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

describe('photo posts over multipart', () => {
  let sid: string

  beforeAll(async () => {
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
    expect(to).toMatch(/^\/posts\//)

    const html = await (await fetch(`${base}${to}`)).text()
    expect(html).toContain('class="u-photo"')
    const src = html.match(/src="(\/media\/[^"]+)"/)?.[1]
    expect(src).toMatch(/^\/media\/\d{4}\/\d{2}\/.+\.png$/)
    expect(html).toContain('alt="A harbor at dusk"')

    const media = await fetch(`${base}${src}`)
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    const etag = media.headers.get('etag')
    expect(etag).toBeTruthy()
    const revalidated = await fetch(`${base}${src}`, { headers: { 'If-None-Match': etag! } })
    expect(revalidated.status).toBe(304)

    // Intrinsic dimensions were probed at upload and rendered for CLS.
    expect(html).toMatch(/width="1"[^>]*height="1"|height="1"[^>]*width="1"/)

    // The URL's extension is the delivery format: request the stored PNG as
    // webp and the endpoint transcodes. An off-allowlist width is a 400.
    const webp = await fetch(`${base}${src!.replace(/\.png$/, '.webp')}?w=400`)
    expect(webp.status).toBe(200)
    expect(webp.headers.get('content-type')).toBe('image/webp')
    expect((await fetch(`${base}${src}?w=999`)).status).toBe(400)
  })

  it('rejects a photo without alt text', async () => {
    const photo = new File([PNG], 'x.png', { type: 'image/png' })
    const result = await publish(sid, { title: '', content: 'No alt.', photo_alt: '' }, photo)
    expect(result.directives?.[0]?.to).toBe('/admin?error=photo-alt')
  })

  it('a media path that escapes the dir or has no known extension 404s', async () => {
    expect((await fetch(`${base}/media/../../etc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/media/2026/08/nope.txt`)).status).toBe(404)
  })

  it('a plain urlencoded publish still works (no photo entry at all)', async () => {
    const result = await publish(sid, { title: 'Words', content: 'Just words.', photo_alt: '' })
    expect(result.directives?.[0]?.to).toMatch(/^\/posts\/words/)
  })
})
