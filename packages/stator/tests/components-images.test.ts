import { describe, expect, it } from 'vitest'
import { getImage, Image, Picture } from '../src/components/images.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/** html`` needs a render context; these components are static, so any works. */
function rendered(make: () => HtmlFragment): string {
  return runInRender(createRenderState('test-session', 'GET /'), make).html
}

describe('getImage', () => {
  it('derives srcset over the endpoint contract, filtered below intrinsic width', () => {
    const r = getImage({ src: '/media/2026/08/x.jpg', width: 1000, height: 500 })
    expect(r.srcset).toBe('/media/2026/08/x.jpg?w=400 400w, /media/2026/08/x.jpg?w=800 800w')
    expect(r.width).toBe(1000)
  })

  it('format swaps the extension — the URL is the delivery contract', () => {
    const r = getImage({ src: '/media/x.jpg', width: 900, height: 600, format: 'webp' })
    expect(r.src).toBe('/media/x.webp')
    expect(r.srcset).toContain('/media/x.webp?w=400 400w')
  })

  it('derives height from aspectRatio', () => {
    const r = getImage({ src: '/media/x.jpg', width: 1200, aspectRatio: 1.5 })
    expect(r.height).toBe(800)
  })

  it('remote URLs and GIFs pass through with no srcset', () => {
    expect(getImage({ src: 'https://a.example/x.jpg', width: 800, height: 600 }).srcset).toBeNull()
    expect(getImage({ src: '/media/x.gif', width: 800, height: 600 }).srcset).toBeNull()
  })
})

describe('<Image>', () => {
  it('emits CLS-safe, lazy-by-default markup', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'A harbor' }),
    )
    expect(html).toContain('width="1000"')
    expect(html).toContain('height="500"')
    expect(html).toContain('alt="A harbor"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).not.toContain('fetchpriority')
  })

  it('priority flips to eager + fetchpriority=high', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', priority: true }),
    )
    expect(html).toContain('loading="eager"')
    expect(html).toContain('fetchpriority="high"')
  })

  it('escapes alt text', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 8, height: 6, alt: '"><script>' }),
    )
    expect(html).not.toContain('"><script>')
  })
})

describe('<Picture>', () => {
  it('renders modern-format sources with the stored format as fallback', () => {
    const html = rendered(() =>
      Picture({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
    )
    expect(html).toContain('<picture')
    expect(html).toContain('type="image/avif"')
    expect(html).toContain('type="image/webp"')
    expect(html).toContain('/media/x.avif?w=400')
    expect(html).toMatch(/<img[^>]*src="\/media\/x\.jpg"/)
  })

  it('collapses to a plain <img> when no sources apply (remote, or too small)', () => {
    const remote = rendered(() =>
      Picture({ src: 'https://a.example/x.jpg', width: 800, height: 600, alt: 'x' }),
    )
    expect(remote).not.toContain('<picture')
    const tiny = rendered(() => Picture({ src: '/media/x.jpg', width: 100, height: 100, alt: 'x' }))
    expect(tiny).not.toContain('<picture')
  })
})

describe('<Picture> art direction', () => {
  it('crosses media sources with every format plus the stored format, before the plain chain', () => {
    const html = rendered(() =>
      Picture({
        src: '/media/x.jpg',
        width: 1600,
        height: 900,
        alt: 'x',
        sources: [{ media: '(max-width: 30rem)', aspect: 1, sizes: '100vw' }],
      }),
    )
    // Art-directed rows carry media + cropped w&h URLs (square: h === w).
    expect(html).toContain('media="(max-width: 30rem)"')
    expect(html).toContain('/media/x.avif?w=400&amp;h=400 400w')
    expect(html).toContain('/media/x.webp?w=400&amp;h=400 400w')
    // The stored format is art-directed too — otherwise a browser with no
    // modern-format support would fall through the media condition entirely.
    expect(html).toContain('/media/x.jpg?w=400&amp;h=400 400w')
    // Plain format chain still present (no media), and AFTER the art rows.
    expect(html.indexOf('media=')).toBeLessThan(html.indexOf('/media/x.avif?w=400 400w'))
  })

  it('skips candidate widths whose derived crop height misses the allowlist', () => {
    const html = rendered(() =>
      Picture({
        src: '/media/x.jpg',
        width: 2000,
        height: 1000,
        alt: 'x',
        sources: [{ media: '(min-width: 60rem)', aspect: 2 }],
      }),
    )
    // aspect 2: only w=800 (h=400) and w=1600 (h=800) land on the allowlist.
    expect(html).toContain('/media/x.avif?w=800&amp;h=400 800w')
    expect(html).toContain('/media/x.avif?w=1600&amp;h=800 1600w')
    expect(html).not.toContain('w=400&amp;h=200')
    expect(html).not.toContain('w=1200&amp;h=600')
  })
})
