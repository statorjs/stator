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

export type PictureProps = ImageProps & {
  /** Modern-format `<source>` chain, most-preferred first. The stored format
   *  stays the `<img>` fallback. */
  formats?: ImageFormat[]
}

const SOURCE_TYPES: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
}

export function Picture(props: PictureProps): HtmlFragment {
  const { formats = ['avif', 'webp'], ...imageProps } = props
  const sources = isRemote(props.src)
    ? []
    : formats
        .map((format) => ({ format, resolved: getImage({ ...props, format }) }))
        .filter((s) => s.resolved.srcset !== null)
  if (sources.length === 0) return Image(imageProps)
  const sizes = props.sizes ?? '100vw'
  return html`<picture
    >${sources.map(
      (s) =>
        html`<source type="${SOURCE_TYPES[s.format]}" srcset="${s.resolved.srcset}" sizes="${sizes}" />`,
    )}${Image(imageProps)}</picture
  >`
}
