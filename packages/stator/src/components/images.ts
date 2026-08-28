import { html } from '../template/html.ts'
import type { HtmlFragment } from '../template/types.ts'

/**
 * `getImage()` + `<Image>`/`<Picture>` — the render half of framework image
 * support (spec `images-are-part-of-stator-*`; endpoint in `server/images.ts`).
 *
 * `src` is the PUBLIC URL of the original: an image-endpoint path
 * (`/media/2026/08/x.jpg`) gets derived variants — the endpoint's contract is
 * that the URL's extension is the delivery format and `?w=` resizes — while a
 * remote URL (`http…`) passes through untouched (the framework never proxies
 * or transforms remote origins).
 *
 * Dimensions are REQUIRED, always, and always come from the caller: the
 * framework never probes at render (renders are synchronous; intrinsic size
 * is write-time data your upload handler stores via `probeImage`). Provide
 * `width`+`height`, or `width`+`aspectRatio` and the height is derived. That
 * rule is what makes every `<Image>` CLS-safe by construction.
 */

export type ImageFormat = 'jpg' | 'png' | 'webp' | 'avif'

/** `width`+`height`, or `width`+`aspectRatio` (height derived). */
export type ImageDims =
  | { width: number; height: number; aspectRatio?: never }
  | { width: number; height?: never; aspectRatio: number }

export type GetImageOptions = ImageDims & {
  src: string
  /** Delivery format for src/srcset URLs — defaults to the URL's extension. */
  format?: ImageFormat
  /** Candidate srcset widths; filtered to those below the intrinsic width.
   *  Default `[400, 800, 1200, 1600]` — mirror your `images.widths` config
   *  if you changed it. */
  widths?: number[]
}

export interface ResolvedImage {
  src: string
  srcset: string | null
  width: number
  height: number
}

const DEFAULT_WIDTHS = [400, 800, 1200, 1600]

const isRemote = (src: string): boolean => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)

const withFormat = (src: string, format: ImageFormat | undefined): string => {
  if (!format) return src
  const dot = src.lastIndexOf('.')
  return dot === -1 ? src : `${src.slice(0, dot)}.${format}`
}

export function getImage(opts: GetImageOptions): ResolvedImage {
  const width = opts.width
  const height = opts.height ?? Math.round(opts.width / opts.aspectRatio!)
  const ext = opts.src.slice(opts.src.lastIndexOf('.') + 1).toLowerCase()
  // Remote URLs pass through; GIFs serve as originals only (the endpoint
  // refuses to transcode them — animation doesn't survive naive resizing).
  if (isRemote(opts.src) || ext === 'gif') {
    return { src: opts.src, srcset: null, width, height }
  }
  const base = withFormat(opts.src, opts.format)
  const candidates = (opts.widths ?? DEFAULT_WIDTHS).filter((w) => w < width)
  const srcset =
    candidates.length > 0 ? candidates.map((w) => `${base}?w=${w} ${w}w`).join(', ') : null
  return { src: base, srcset, width, height }
}

export type ImageProps = GetImageOptions & {
  /** Required — an image without alt text is a compile error on purpose.
   *  Decorative images say so explicitly with `alt=""`. */
  alt: string
  sizes?: string
  /** The LCP escape hatch: eager + fetchpriority=high for the one
   *  above-the-fold image. Everything else stays lazy — lazy-loading a hero
   *  is the classic self-inflicted LCP regression. */
  priority?: boolean
  class?: string
}

export function Image(props: ImageProps): HtmlFragment {
  const img = getImage(props)
  return html`<img
    src="${img.src}"
    srcset="${img.srcset ?? undefined}"
    sizes="${img.srcset ? (props.sizes ?? '100vw') : undefined}"
    alt="${props.alt}"
    width="${img.width}"
    height="${img.height}"
    loading="${props.priority ? 'eager' : 'lazy'}"
    fetchpriority="${props.priority ? 'high' : undefined}"
    decoding="async"
    class="${props.class ?? undefined}"
  />`
}

/** An art-directed source: under `media`, serve a different GEOMETRY — an
 *  `aspect` (width/height) the endpoint cover-crops to. Both crop axes must
 *  land on the width allowlist, so pick aspects whose `round(w / aspect)` hits
 *  allowlisted values (1 always works; with the default widths so do 2, 3,
 *  1/2, 4/3 at some widths — off-allowlist heights are skipped per width). */
export interface PictureSource {
  media: string
  /** width / height. `1` = square crop. */
  aspect: number
  sizes?: string
  widths?: number[]
}

export type PictureProps = ImageProps & {
  /** Modern-format `<source>` chain, most-preferred first. The stored format
   *  stays the `<img>` fallback. */
  formats?: ImageFormat[]
  /** Art direction — this is where `<picture>` earns its difficulty: each
   *  entry crosses with every format (media × type sources, most specific
   *  first), and the plain-format chain follows for non-matching viewports. */
  sources?: PictureSource[]
}

const SOURCE_TYPES: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
}

/** Cropped srcset for an art-directed source: every allowlisted candidate
 *  width whose derived height is ALSO allowlisted (the endpoint's crop bound)
 *  and that stays below the intrinsic width. */
function croppedSrcset(
  src: string,
  format: ImageFormat | undefined,
  widths: number[],
  aspect: number,
  intrinsicWidth: number,
): string | null {
  const base = withFormat(src, format)
  const entries = widths
    .filter((w) => w < intrinsicWidth)
    .map((w) => ({ w, h: Math.round(w / aspect) }))
    .filter(({ h }) => widths.includes(h))
    .map(({ w, h }) => `${base}?w=${w}&h=${h} ${w}w`)
  return entries.length > 0 ? entries.join(', ') : null
}

export function Picture(props: PictureProps): HtmlFragment {
  const { formats = ['avif', 'webp'], sources: artSources = [], ...imageProps } = props
  if (isRemote(props.src)) return Image(imageProps)

  const storedExt = props.src.slice(props.src.lastIndexOf('.') + 1).toLowerCase() as ImageFormat
  const widths = props.widths ?? DEFAULT_WIDTHS
  const sizes = props.sizes ?? '100vw'

  // Art-directed sources come FIRST (the browser takes the first media+type
  // match), each crossed with every modern format plus the stored format —
  // without the stored-format row, a browser supporting none of the modern
  // formats would fall past the media condition to the uncropped fallback.
  const art = artSources.flatMap((source) =>
    [...formats, storedExt]
      .filter((f, i, all) => all.indexOf(f) === i && f in SOURCE_TYPES)
      .map((format) => ({
        media: source.media,
        format: format as ImageFormat,
        srcset: croppedSrcset(
          props.src,
          format as ImageFormat,
          source.widths ?? widths,
          source.aspect,
          props.width,
        ),
        sizes: source.sizes ?? sizes,
      }))
      .filter((s) => s.srcset !== null),
  )
  const plain = formats
    .map((format) => ({
      media: undefined,
      format,
      srcset: getImage({ ...props, format }).srcset,
      sizes,
    }))
    .filter((s) => s.srcset !== null)

  const all = [...art, ...plain]
  if (all.length === 0) return Image(imageProps)
  return html`<picture
    >${all.map(
      (s) =>
        html`<source media="${s.media ?? undefined}" type="${SOURCE_TYPES[s.format]}" srcset="${s.srcset}" sizes="${s.sizes}" />`,
    )}${Image(imageProps)}</picture
  >`
}
