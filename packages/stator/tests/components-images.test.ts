import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Image from '../src/components/image.stator.ts'
import { getImage, getPicture, SOURCE_TYPES } from '../src/components/images.ts'
import Picture from '../src/components/picture.stator.ts'
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
    assert.equal(r.srcset, '/media/2026/08/x.jpg?w=400 400w, /media/2026/08/x.jpg?w=800 800w')
    assert.equal(r.width, 1000)
  })

  it('format swaps the extension — the URL is the delivery contract', () => {
    const r = getImage({ src: '/media/x.jpg', width: 900, height: 600, format: 'webp' })
    assert.equal(r.src, '/media/x.webp')
    assert.ok(r.srcset)
    assert.ok(r.srcset.includes('/media/x.webp?w=400 400w'))
  })

  it('remote URLs, GIFs and SVGs pass through with no srcset', () => {
    assert.equal(getImage({ src: 'https://a.example/x.jpg', width: 800, height: 600 }).srcset, null)
    assert.equal(getImage({ src: '/media/x.gif', width: 800, height: 600 }).srcset, null)
    assert.equal(getImage({ src: '/media/mark.svg', width: 256, height: 256 }).srcset, null)
  })

  it('crop emits w+h URLs and reports the CROPPED box, not the source shape', () => {
    const r = getImage({ src: '/media/x.jpg', width: 2048, height: 1536, crop: 1 })
    assert.ok(r.srcset)
    assert.ok(r.srcset.includes('/media/x.jpg?w=400&h=400 400w'))
    assert.ok(r.srcset)
    assert.ok(r.srcset.includes('/media/x.jpg?w=1600&h=1600 1600w'))
    // src is the largest rung, and width/height describe THAT resource — so
    // the reserved box is square even though the original is 4:3.
    assert.equal(r.src, '/media/x.jpg?w=1600&h=1600')
    assert.equal(r.width, 1600)
    assert.equal(r.height, 1600)
  })

  it('crop with no rung below the intrinsic width degrades to the uncropped original', () => {
    const r = getImage({ src: '/media/tiny.jpg', width: 120, height: 90, crop: 1 })
    assert.equal(r.src, '/media/tiny.jpg')
    assert.equal(r.srcset, null)
    assert.equal(r.width, 120)
  })
})

describe('getPicture', () => {
  const inRender = <T>(fn: () => T): T =>
    runInRender(createRenderState('test-session', 'GET /'), fn)

  it('resolves the same sources <Picture> renders, as data — no markup', () => {
    const { sources, image } = inRender(() =>
      getPicture({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
    )
    assert.deepStrictEqual(
      sources.map((s) => s.format),
      ['avif', 'webp'],
    )
    assert.equal(
      sources.every((s) => s.srcset.includes('.avif') || s.srcset.includes('.webp')),
      true,
    )
    assert.equal(image.src, '/media/x.jpg')
    assert.equal(image.width, 1000)
  })

  it('collapses to no sources when remote or too small — same cases <Picture> collapses on', () => {
    const remote = inRender(() =>
      getPicture({ src: 'https://a.example/x.jpg', width: 800, height: 600, alt: 'x' }),
    )
    assert.deepStrictEqual(remote.sources, [])
    const tiny = inRender(() =>
      getPicture({ src: '/media/x.jpg', width: 100, height: 100, alt: 'x' }),
    )
    assert.deepStrictEqual(tiny.sources, [])
  })

  it('a custom <picture> can build its own <source> tags from SOURCE_TYPES', () => {
    const { sources } = inRender(() =>
      getPicture({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
    )
    for (const s of sources) assert.match(SOURCE_TYPES[s.format], /^image\//)
  })
})

describe('<Image>', () => {
  it('emits CLS-safe, lazy-by-default markup', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'A harbor' }),
    )
    assert.ok(html.includes('width="1000"'))
    assert.ok(html.includes('height="500"'))
    assert.ok(html.includes('alt="A harbor"'))
    assert.ok(html.includes('loading="lazy"'))
    assert.ok(html.includes('decoding="async"'))
    assert.ok(!html.includes('fetchpriority'))
  })

  it('priority flips to eager + fetchpriority=high', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', priority: true }),
    )
    assert.ok(html.includes('loading="eager"'))
    assert.ok(html.includes('fetchpriority="high"'))
  })

  it('the native attributes are separately settable — the grid case the rollup cannot express', () => {
    // Eager (no lazy layout delay) WITHOUT claiming high priority: every
    // first-row thumbnail, where only the first is the LCP candidate.
    const eagerOnly = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', loading: 'eager' }),
    )
    assert.ok(eagerOnly.includes('loading="eager"'))
    assert.ok(!eagerOnly.includes('fetchpriority'))

    const low = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', fetchpriority: 'low' }),
    )
    assert.ok(low.includes('fetchpriority="low"'))
    assert.ok(low.includes('loading="lazy"'))
  })

  it('decoding is overridable — it was hardcoded with no escape at all', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 800, height: 600, alt: '', decoding: 'sync' }),
    )
    assert.ok(html.includes('decoding="sync"'))
  })

  it('escapes alt text', () => {
    const html = rendered(() =>
      Image({ src: '/media/x.jpg', width: 8, height: 6, alt: '"><script>' }),
    )
    assert.ok(!html.includes('"><script>'))
  })
})

describe('<Picture>', () => {
  it('renders modern-format sources with the stored format as fallback', () => {
    const html = rendered(() =>
      Picture({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
    )
    assert.ok(html.includes('<picture'))
    assert.ok(html.includes('type="image/avif"'))
    assert.ok(html.includes('type="image/webp"'))
    assert.ok(html.includes('/media/x.avif?w=400'))
    assert.match(html, /<img[^>]*src="\/media\/x\.jpg"/)
  })

  it('collapses to a plain <img> when no sources apply (remote, or too small)', () => {
    const remote = rendered(() =>
      Picture({ src: 'https://a.example/x.jpg', width: 800, height: 600, alt: 'x' }),
    )
    assert.ok(!remote.includes('<picture'))
    const tiny = rendered(() => Picture({ src: '/media/x.jpg', width: 100, height: 100, alt: 'x' }))
    assert.ok(!tiny.includes('<picture'))
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
    assert.ok(html.includes('/media/x.avif?w=400&amp;h=400 400w'))
    assert.ok(html.includes('/media/x.webp?w=800&amp;h=800 800w'))
    // ...with no always-true media condition standing in for "always".
    assert.ok(!html.includes('media='))
    // The fallback <img> is cropped too, and its reserved box is SQUARE —
    // under art-direction-only cropping it advertised the source's 4:3.
    assert.match(html, /<img[^>]*src="\/media\/x\.jpg\?w=800&amp;h=800"/)
    assert.ok(html.includes('width="800"'))
    assert.ok(html.includes('height="800"'))
    assert.ok(!html.includes('height="1536"'))
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
    assert.ok(html.includes('media="(min-width: 60rem)"'))
    assert.ok(html.includes('/media/x.avif?w=800&amp;h=450 800w'))
    // The no-media rows keep the component-level square crop.
    assert.ok(html.includes('/media/x.avif?w=800&amp;h=800 800w'))
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
    assert.ok(html.includes('media="(max-width: 30rem)"'))
    assert.ok(html.includes('/media/x.avif?w=400&amp;h=400 400w'))
    assert.ok(html.includes('/media/x.webp?w=400&amp;h=400 400w'))
    // The stored format is art-directed too — otherwise a browser with no
    // modern-format support would fall through the media condition entirely.
    assert.ok(html.includes('/media/x.jpg?w=400&amp;h=400 400w'))
    // Plain format chain still present (no media), and AFTER the art rows.
    assert.ok(html.indexOf('media=') < html.indexOf('/media/x.avif?w=400 400w'))
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
    assert.ok(html.includes('/media/x.avif?w=400&amp;h=225 400w'))
    assert.ok(html.includes('/media/x.avif?w=800&amp;h=450 800w'))
    assert.ok(html.includes('/media/x.avif?w=1600&amp;h=900 1600w'))
  })

  it('a crop missing from the configured allowlist throws — never a silent drop', () => {
    assert.throws(
      () =>
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
      /crop 2.35/,
    )
  })

  it('srcset widths follow the CONFIGURED allowlist from the render state — no drift', () => {
    const html = rendered(
      () => Image({ src: '/media/x.jpg', width: 1000, height: 500, alt: 'x' }),
      { widths: [320, 640, 960], aspectRatios: [1] },
    )
    assert.ok(html.includes('/media/x.jpg?w=320 320w'))
    assert.ok(html.includes('/media/x.jpg?w=640 640w'))
    assert.ok(!html.includes('w=400'))
  })
})
