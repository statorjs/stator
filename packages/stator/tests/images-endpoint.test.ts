import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
    expect(res.status).toBe(404)
  })

  it('serves originals under the dir-name path with ETag revalidation', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media' })
    const res = await app.fetch(new Request('http://localhost/media/2026/08/probe.png'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const revalidated = await app.fetch(
      new Request('http://localhost/media/2026/08/probe.png', {
        headers: { 'If-None-Match': etag! },
      }),
    )
    expect(revalidated.status).toBe(304)
  })

  it('the URL extension is the delivery format — transcodes, never lies', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media' })
    const webp = await app.fetch(new Request('http://localhost/media/2026/08/probe.webp?w=400'))
    expect(webp.status).toBe(200)
    expect(webp.headers.get('content-type')).toBe('image/webp')
  })

  it('rejects off-allowlist widths and traversal', async () => {
    const app = await boot({ dir: mediaDir(), path: '/media', widths: [400] })
    expect(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?w=999'))).status,
    ).toBe(400)
    expect((await app.fetch(new Request('http://localhost/media/../etc/passwd.png'))).status).toBe(
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
    expect(crop.status).toBe(200)
    const { default: sharp } = await import('sharp')
    const meta = await sharp(new Uint8Array(await crop.arrayBuffer())).metadata()
    expect(meta.width).toBe(400)
    expect(meta.height).toBe(400)
    expect(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?h=400'))).status,
    ).toBe(400)
    expect(
      (await app.fetch(new Request('http://localhost/media/2026/08/probe.png?w=400&h=999'))).status,
    ).toBe(400)
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
    expect(slow.status).toBe(302)
    expect(slow.headers.get('location')).toBe('/media/2026/08/probe.png')
    // The fallback must never stick in a shared cache.
    expect(slow.headers.get('cache-control')).toBe('no-store')

    settle()
    await new Promise((r) => setTimeout(r, 10))
    const warm = await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    expect(warm.status).toBe(200)
    expect(warm.headers.get('content-type')).toBe('image/webp')
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
    expect(res.status).toBe(200)
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
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
    // A reseed resets mtimes without changing bytes — the ETag must hold.
    utimesSync(join(dir, '2026', '08', 'probe.png'), new Date(), new Date())
    const reseeded = await app.fetch(new Request(url))
    expect(reseeded.headers.get('etag')).toBe(etag)
    // A genuine content change under the same URL must bust.
    writeFileSync(join(dir, '2026', '08', 'probe.png'), PNG2)
    const changed = await app.fetch(new Request(url))
    expect(changed.headers.get('etag')).not.toBe(etag)
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
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}-400-webp"$/)
    expect(encodes).toBe(1)
    // Revalidation answers from the validator alone — no encode, and it would
    // succeed even if the variant file had never been written.
    const revalidated = await serveImage(config, '2026/08/probe.webp', '400', undefined, etag)
    expect(revalidated.status).toBe(304)
    expect(encodes).toBe(1)
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
    expect(encodes).toBe(1) // cache hit by existence — no mtime comparison
    writeFileSync(join(dir, '2026', '08', 'probe.png'), PNG2)
    await serveImage(config, '2026/08/probe.webp', '400', undefined, null)
    expect(encodes).toBe(2) // new hash → new cache name → miss → re-encode
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
    expect(await cc({})).toBe('public, max-age=0, must-revalidate')
    expect(await cc({ staleWhileRevalidate: 86400 })).toBe(
      'public, max-age=0, stale-while-revalidate=86400',
    )
    expect(await cc({ maxAge: 3600 })).toBe('public, max-age=3600')
    expect(await cc({ maxAge: 31536000, immutable: true })).toBe(
      'public, max-age=31536000, immutable',
    )
    // immutable without a nonzero maxAge is inert — the no-recovery marker
    // never rides the revalidation default.
    expect(await cc({ immutable: true })).toBe('public, max-age=0, must-revalidate')
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
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    )
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const etag = res.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
    const revalidated = await app.fetch(
      new Request('http://localhost/media/2026/mark.svg', { headers: { 'If-None-Match': etag } }),
    )
    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('content-security-policy')).toBeTruthy()
  })

  it('never resizes, rasterizes, or vectorizes — variants refused in every direction', async () => {
    const app = await boot({ dir: svgDir(), path: '/media' })
    // ?w= on an svg: allowlisted width, but svg is an originals-only source.
    expect(
      (await app.fetch(new Request('http://localhost/media/2026/mark.webp?w=400'))).status,
    ).toBe(404)
    expect(
      (await app.fetch(new Request('http://localhost/media/2026/mark.svg?w=400'))).status,
    ).toBe(404)
    // A raster original never fabricates an svg.
    expect((await app.fetch(new Request('http://localhost/media/2026/photo.svg'))).status).toBe(404)
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
    expect(await t.probe(new Uint8Array(stored))).toEqual({ width: 20, height: 40 })

    // A transformed variant is upright pixels with no orientation tag left
    // to die in transit.
    const out = await t.transform(new Uint8Array(stored), { format: 'jpeg' })
    const meta = await sharp(out).metadata()
    expect(meta.orientation).toBeUndefined()
    expect(meta.width).toBe(20)
    expect(meta.height).toBe(40)
  })
})
