import { describe, expect, it } from 'vitest'
import { getImage, Image, Picture } from '../src/components/images.ts'
import { createRenderState, runInRender } from '../src/server/render-context.ts'
import type { HtmlFragment } from '../src/template/types.ts'

/** html`` needs a render context; these components are static, so any works.
 *  Pass `images` to simulate rendering inside an app with images configured
 *  (the endpoint's widths/aspects carried on the render state). */
function rendered(
  make: () => HtmlFragment,
  images?: { widths: number[]; aspectRatios: number[] },
): string {
  const state = createRenderState('test-session', 'GET /')
  state.images = images
  return runInRender(state, make).html
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

  it('remote URLs, GIFs and SVGs pass through with no srcset', () => {
    expect(getImage({ src: 'https://a.example/x.jpg', width: 800, height: 600 }).srcset).toBeNull()
    expect(getImage({ src: '/media/x.gif', width: 800, height: 600 }).srcset).toBeNull()
    expect(getImage({ src: '/media/mark.svg', width: 256, height: 256 }).srcset).toBeNull()
  })

  it('crop emits w+h URLs and reports the CROPPED box, not the source shape', () => {
    const r = getImage({ src: '/media/x.jpg', width: 2048, height: 1536, crop: 1 })
    expect(r.srcset).toContain('/media/x.jpg?w=400&h=400 400w')
    expect(r.srcset).toContain('/media/x.jpg?w=1600&h=1600 1600w')
    // src is the largest rung, and width/height describe THAT resource — so
    // the reserved box is square even though the original is 4:3.
    expect(r.src).toBe('/media/x.jpg?w=1600&h=1600')
    expect(r.width).toBe(1600)
    expect(r.height).toBe(1600)
  })

  it('crop with no rung below the intrinsic width degrades to the uncropped original', () => {
    const r = getImage({ src: '/media/tiny.jpg', width: 120, height: 90, crop: 1 })
    expect(r.src).toBe('/media/tiny.jpg')
    expect(r.srcset).toBeNull()
    expect(r.width).toBe(120)
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

  it('the native attributes are separately settable — the grid case the rollup cannot express', () => {
    // Eager (no lazy layout delay) WITHOUT claiming high priority: every
    // first-row thumbnail, where only the first is the LCP candidate.
    const eagerOnly = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', loading: 'eager' }),
    )
    expect(eagerOnly).toContain('loading="eager"')
    expect(eagerOnly).not.toContain('fetchpriority')

    const low = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', fetchpriority: 'low' }),
    )
    expect(low).toContain('fetchpriority="low"')
    expect(low).toContain('loading="lazy"')
  })

  it('decoding is overridable — it was hardcoded with no escape at all', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', decoding: 'sync' }),
    )
    expect(html).toContain('decoding="sync"')
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

describe('<Picture> crop', () => {
  it('a fixed crop needs no media query — sources and the fallback box are all square', () => {
    const html = rendered(() =>
      Picture({
        src: '/media/x.jpg',
        width: 2048,
        height: 1536,
        alt: 'x',
        crop: 1,
        widths: [400, 800],
      }),
    )
    // Every format row is cropped...
    expect(html).toContain('/media/x.avif?w=400&amp;h=400 400w')
    expect(html).toContain('/media/x.webp?w=800&amp;h=800 800w')
    // ...with no always-true media condition standing in for "always".
    expect(html).not.toContain('media=')
    // The fallback <img> is cropped too, and its reserved box is SQUARE —
    // under art-direction-only cropping it advertised the source's 4:3.
    expect(html).toMatch(/<img[^>]*src="\/media\/x\.jpg\?w=800&amp;h=800"/)
    expect(html).toContain('width="800"')
    expect(html).toContain('height="800"')
    expect(html).not.toContain('height="1536"')
  })

  it('a per-source crop overrides the fixed one for its breakpoint', () => {
    const html = rendered(() =>
      Picture({
        src: '/media/x.jpg',
        width: 2000,
        height: 1000,
        alt: 'x',
        crop: 1,
        sources: [{ media: '(min-width: 60rem)', crop: 16 / 9 }],
      }),
    )
    expect(html).toContain('media="(min-width: 60rem)"')
    expect(html).toContain('/media/x.avif?w=800&amp;h=450 800w')
    // The no-media rows keep the component-level square crop.
    expect(html).toContain('/media/x.avif?w=800&amp;h=800 800w')
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
        sources: [{ media: '(max-width: 30rem)', crop: 1, sizes: '100vw' }],
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

  it('photographic aspects emit every candidate width (16:9 was impossible under the first cut)', () => {
    const html = rendered(() =>
      Picture({
        src: '/media/x.jpg',
        width: 2000,
        height: 1000,
        alt: 'x',
        sources: [{ media: '(min-width: 60rem)', crop: 16 / 9 }],
      }),
    )
    expect(html).toContain('/media/x.avif?w=400&amp;h=225 400w')
    expect(html).toContain('/media/x.avif?w=800&amp;h=450 800w')
    expect(html).toContain('/media/x.avif?w=1600&amp;h=900 1600w')
  })

  it('a crop missing from the configured allowlist throws — never a silent drop', () => {
    expect(() =>
      rendered(
        () =>
          Picture({
            src: '/media/x.jpg',
            width: 2000,
            height: 1000,
            alt: 'x',
            sources: [{ media: '(min-width: 60rem)', crop: 2.35 }],
          }),
        { widths: [400, 800], aspectRatios: [1, 16 / 9] },
      ),
    ).toThrow(/crop 2.35/)
  })

  it('srcset widths follow the CONFIGURED allowlist from the render state — no drift', () => {
    const html = rendered(
      () => Image({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
      { widths: [320, 640, 960], aspectRatios: [1] },
    )
    expect(html).toContain('/media/x.jpg?w=320 320w')
    expect(html).toContain('/media/x.jpg?w=640 640w')
    expect(html).not.toContain('w=400')
  })
})
