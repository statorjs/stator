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
