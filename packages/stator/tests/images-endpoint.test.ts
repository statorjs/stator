import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, type StatorApp } from '../src/server/create-app.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, 'fixtures')

// A real 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

async function boot(images?: {
  dir: string
  path?: string
  widths?: number[]
}): Promise<StatorApp> {
  return createApp({
    machinesDir: resolve(fixtures, 'machines'),
    routesDir: resolve(fixtures, 'routes'),
    images,
  })
}

function mediaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stator-images-'))
  mkdirSync(join(dir, '2026', '08'), { recursive: true })
  writeFileSync(join(dir, '2026', '08', 'probe.png'), PNG)
  return dir
}

describe('image endpoint', () => {
  it('is absent unless configured — zero route-space claim', async () => {
    const app = await boot()
    const res = await app.fetch(new Request('http://localhost/media/2026/08/probe.png'))
    assert.equal(res.status, 404)
  })

  it('serves originals under the dir-name path with ETag revalidation', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media' })
    const res = await app.fetch(new Request('http://localhost/media/2026/08/probe.png'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const etag = res.headers.get('etag')
    assert.ok(etag)
    const revalidated = await app.fetch(
      new Request('http://localhost/media/2026/08/probe.png', {
        headers: { 'If-None-Match': etag! },
      }),
    )
    assert.equal(revalidated.status, 304)
  })

  it('the URL extension is the delivery format — transcodes, never lies', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media' })
    const webp = await app.fetch(new Request('http://localhost/media/2026/08/probe.webp?w=400'))
    assert.equal(webp.status, 200)
    assert.equal(webp.headers.get('content-type'), 'image/webp')
  })

  it('rejects off-allowlist widths and traversal', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media', widths: [400] })
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?w=999'))).status,
      400,
    )
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/../etc/passwd.png'))).status,
      404,
    )
  })
})

describe('image endpoint: crops', () => {
  it('w+h cover-crops to the exact box; h alone or off-allowlist is a 400', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media' })
    const crop = await app.fetch(
      new Request('http://localhost/media/2026/08/probe.webp?w=400&h=400'),
    )
    assert.equal(crop.status, 200)
    const { default: sharp } = await import('sharp')
    const meta = await sharp(new Uint8Array(await crop.arrayBuffer())).metadata()
    assert.equal(meta.width, 400)
    assert.equal(meta.height, 400)
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?h=400'))).status,
      400,
    )
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?w=400&h=999'))).status,
      400,
    )
  })
})

describe('image endpoint: encode deadline', () => {
  it('a slow encode degrades to a 302 at the stored original; the finished variant serves next time', async () => {
    const { resolveImagesConfig, serveImage } = await import('../src/server/images.ts')
    // Settles AFTER the deadline — never leave a semaphore slot dangling.
    let settle!: () => void
    const gate = new Promise<void>((r) => (settle = r))
    const config = resolveImagesConfig({
      dir: mediaDir(),
      path: '/media',
      encodeTimeoutMs: 30,
      transformer: {
        probe: async () => ({ width: 1, height: 1 }),
        transform: async () => {
          await gate
          return PNG
        },
      },
    })

    const slow = await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(slow.status, 302)
    assert.equal(slow.headers.get('location'), '/media/2026/08/probe.png')
    // The fallback must never stick in a shared cache.
    assert.equal(slow.headers.get('cache-control'), 'no-store')

    settle()
    await new Promise((r) => setTimeout(r, 10))
    const warm = await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(warm.status, 200)
    assert.equal(warm.headers.get('content-type'), 'image/webp')
  })

  it('encodeTimeoutMs: 0 disables the deadline — the request waits', async () => {
    const { resolveImagesConfig, serveImage } = await import('../src/server/images.ts')
    const config = resolveImagesConfig({
      dir: mediaDir(),
      path: '/media',
      encodeTimeoutMs: 0,
      transformer: {
        probe: async () => ({ width: 1, height: 1 }),
        transform: async () => {
          await new Promise((r) => setTimeout(r, 60))
          return PNG
        },
      },
    })
    const res = await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(res.status, 200)
  })
})

describe('image endpoint: content-hash validators and the freshness dial', () => {
  // A second real 1x1 PNG with different bytes (one opaque black pixel).
  const PNG2 = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAX+XLaAAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  )

  it('original ETag is a strong content hash — mtime churn does not bust, byte changes do', async () => {
    const { utimesSync } = await import('node:fs')
    const dir = mediaDir()
    const app = await boot({ dir, path: '/media' })
    const url = 'http://localhost/media/2026/08/probe.png'
    const first = await app.fetch(new Request(url))
    const etag = first.headers.get('etag')!
    assert.match(etag, /^"[0-9a-f]{16}"$/)
    // A reseed resets mtimes without changing bytes — the ETag must hold.
    utimesSync(join(dir, '2026', '08', 'probe.png'), new Date(), new Date())
    const reseeded = await app.fetch(new Request(url))
    assert.equal(reseeded.headers.get('etag'), etag)
    // A genuine content change under the same URL must bust.
    writeFileSync(join(dir, '2026', '08', 'probe.png'), PNG2)
    const changed = await app.fetch(new Request(url))
    assert.notEqual(changed.headers.get('etag'), etag)
  })

  it('variant ETag is weak, and a match 304s before any encode runs', async () => {
    const { resolveImagesConfig, serveImage } = await import('../src/server/images.ts')
    let encodes = 0
    const config = resolveImagesConfig({
      dir: mediaDir(),
      path: '/media',
      transformer: {
        probe: async () => ({ width: 1, height: 1 }),
        transform: async () => {
          encodes += 1
          return PNG
        },
      },
    })
    const first = await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(first.status, 200)
    const etag = first.headers.get('etag')!
    assert.match(etag, /^W\/"[0-9a-f]{16}-400-webp"$/)
    assert.equal(encodes, 1)
    // Revalidation answers from the validator alone — no encode, and it would
    // succeed even if the variant file had never been written.
    const revalidated = await serveImage(config, '2026/08/probe.webp', '400', undefined, etag)
    assert.equal(revalidated.status, 304)
    assert.equal(encodes, 1)
  })

  it('variant freshness rides the source hash in the filename — changed original re-encodes', async () => {
    const { resolveImagesConfig, serveImage } = await import('../src/server/images.ts')
    const dir = mediaDir()
    let encodes = 0
    const config = resolveImagesConfig({
      dir,
      path: '/media',
      transformer: {
        probe: async () => ({ width: 1, height: 1 }),
        transform: async () => {
          encodes += 1
          return PNG
        },
      },
    })
    await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(encodes, 1) // cache hit by existence — no mtime comparison
    writeFileSync(join(dir, '2026', '08', 'probe.png'), PNG2)
    await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    assert.equal(encodes, 2) // new hash → new cache name → miss → re-encode
  })

  it('the freshness dial: default revalidates, SWR swaps must-revalidate, immutable needs a long maxAge', async () => {
    const { resolveImagesConfig, serveImage } = await import('../src/server/images.ts')
    const stub = {
      probe: async () => ({ width: 1, height: 1 }),
      transform: async () => PNG,
    }
    const cc = async (extra: object) => {
      const config = resolveImagesConfig({
        dir: mediaDir(),
        path: '/media',
        transformer: stub,
        ...extra,
      })
      const res = await serveImage(config, '2026/08/probe.png', undefined, undefined, null)
      return res.headers.get('cache-control')
    }
    assert.equal(await cc({}), 'public, max-age=0, must-revalidate')
    assert.equal(
      await cc({ staleWhileRevalidate: 86400 }),
      'public, max-age=0, stale-while-revalidate=86400',
    )
    assert.equal(await cc({ maxAge: 3600 }), 'public, max-age=3600')
    assert.equal(
      await cc({ maxAge: 31536000, immutable: true }),
      'public, max-age=31536000, immutable',
    )
    // immutable without a nonzero maxAge is inert — the no-recovery marker
    // never rides the revalidation default.
    assert.equal(await cc({ immutable: true }), 'public, max-age=0, must-revalidate')
  })
})

describe('image endpoint: svg passthrough', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

  function svgDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stator-svg-'))
    mkdirSync(join(dir, '2026'), { recursive: true })
    writeFileSync(join(dir, '2026', 'mark.svg'), SVG)
    writeFileSync(join(dir, '2026', 'photo.png'), PNG)
    return dir
  }

  it('serves the original with neutralizing security headers and a strong ETag', async () => {
    const app = await boot({ dir: svgDir(), path: '/media' })
    const res = await app.fetch(new Request('http://localhost/media/2026/mark.svg'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/svg+xml')
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'unsafe-inline'",
    )
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const etag = res.headers.get('etag')!
    assert.match(etag, /^"[0-9a-f]{16}"$/)
    const revalidated = await app.fetch(
      new Request('http://localhost/media/2026/mark.svg', { headers: { 'If-None-Match': etag } }),
    )
    assert.equal(revalidated.status, 304)
    assert.ok(revalidated.headers.get('content-security-policy'))
  })

  it('never resizes, rasterizes, or vectorizes — variants refused in every direction', async () => {
    const app = await boot({ dir: svgDir(), path: '/media' })
    // ?w= on an svg: allowlisted width, but svg is an originals-only source.
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/mark.webp?w=400'))).status,
      404,
    )
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/mark.svg?w=400'))).status,
      404,
    )
    // A raster original never fabricates an svg.
    assert.equal(
      (await app.fetch(new Request('http://localhost/media/2026/photo.svg'))).status,
      404,
    )
  })
})

describe('image transformer: EXIF orientation', () => {
  it('probe reports display dims; transform bakes the rotation in and drops the tag', async () => {
    const { sharpTransformer } = await import('../src/server/images.ts')
    const { default: sharp } = await import('sharp')
    // A 40x20 jpeg stamped orientation 6 (90° CW) — displays as 20x40.
    const stored = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#456789' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const t = sharpTransformer()

    // The CLS box must be the DISPLAY box, not the stored raster.
    assert.deepStrictEqual(await t.probe(new Uint8Array(stored)), { width: 20, height: 40 })

    // A transformed variant is upright pixels with no orientation tag left
    // to die in transit.
    const out = await t.transform(new Uint8Array(stored), { format: 'jpeg' })
    const meta = await sharp(out).metadata()
    assert.equal(meta.orientation, undefined)
    assert.equal(meta.width, 20)
    assert.equal(meta.height, 40)
  })
})
