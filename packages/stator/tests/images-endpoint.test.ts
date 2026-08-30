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
