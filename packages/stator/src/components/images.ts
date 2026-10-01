import { DEFAULT_IMAGE_WIDTHS } from '../server/images.ts'
import { currentImages } from '../server/render-context.ts'
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

export type GetImageOptions = {
  src: string
  /** Intrinsic dimensions — BOTH required, always from data (`probeImage` at
   *  upload), never probed at render. That rule is what makes every `<Image>`
   *  CLS-safe by construction. (An earlier cut also accepted
   *  `width`+`aspectRatio` and derived the height; it had no consumers, and
   *  spending the word `aspectRatio` on "the shape my source happens to be"
   *  blocked it from meaning "the shape I want" — which is `crop`, below.) */
  width: number
  height: number
  /** Delivery format for src/srcset URLs — defaults to the URL's extension. */
  format?: ImageFormat
  /** Candidate srcset widths; filtered to those below the intrinsic width.
   *  Defaults to the CONFIGURED `images.widths` when rendering inside an app
   *  with images configured (read from the render state — no drift), else the
   *  shipped default. */
  widths?: number[]
  /** Cover-crop the delivered variants to this ratio (width / height): `1` is
   *  square, `16 / 9` widescreen. The ratio must be on the endpoint's crop
   *  allowlist (`images.aspectRatios`) — an unlisted one throws rather than
   *  silently emitting URLs the endpoint would 400. Omit for the source's own
   *  shape. Cropping is what `<picture>` art direction does per breakpoint;
   *  as a plain prop it also covers the common case of one fixed geometry
   *  (a thumbnail grid), which previously needed an always-true media query. */
  crop?: number
}

export interface ResolvedImage {
  src: string
  srcset: string | null
  width: number
  height: number
}

/** Widths for srcset candidates: the explicit prop wins, then the CONFIGURED
 *  endpoint allowlist (carried on the render state, so components can't emit
 *  a `?w=` the endpoint rejects), then the shipped default — the same one the
 *  endpoint defaults to, imported, not copied. */
function effectiveWidths(explicit: number[] | undefined): number[] {
  return explicit ?? currentImages()?.widths ?? DEFAULT_IMAGE_WIDTHS
}

const isRemote = (src: string): boolean => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)

const withFormat = (src: string, format: ImageFormat | undefined): string => {
  if (!format) return src
  const dot = src.lastIndexOf('.')
  return dot === -1 ? src : `${src.slice(0, dot)}.${format}`
}

/** A crop ratio must be on the endpoint's allowlist or its URLs would 400 —
 *  a render error, never a silent drop. Validated once, up front, for both the
 *  plain `crop` prop and every art-directed source. */
function assertCropAllowed(crop: number): void {
  const allowed = currentImages()?.aspectRatios
  if (allowed && !allowed.some((a) => Math.abs(a - crop) < 1e-9)) {
    throw new Error(
      `stator: crop ${crop} is not in images.aspectRatios ` +
        `(${allowed.map((a) => a.toFixed(4)).join(', ')}) — the endpoint would reject its URLs. ` +
        `Add it to the config allowlist or use a listed ratio.`,
    )
  }
}

export function getImage(opts: GetImageOptions): ResolvedImage {
  const { src, width, height, format, widths, crop } = opts
  const ext = src.slice(src.lastIndexOf('.') + 1).toLowerCase()
  // Remote URLs pass through; GIF and SVG serve as originals only — the
  // endpoint refuses to transform either (animation doesn't survive naive
  // resizing; a vector document has no pixels to resample).
  if (isRemote(src) || ext === 'gif' || ext === 'svg') {
    return { src, srcset: null, width, height }
  }
  const base = withFormat(src, format)
  const candidates = effectiveWidths(widths).filter((w) => w < width)

  if (crop === undefined) {
    const srcset =
      candidates.length > 0 ? candidates.map((w) => `${base}?w=${w} ${w}w`).join(', ') : null
    return { src: base, srcset, width, height }
  }

  assertCropAllowed(crop)
  // A crop URL must name an allowlisted width; with none below the intrinsic
  // width there is no valid variant to ask for, so the original serves
  // uncropped (CSS `object-fit` still covers) rather than emitting a 400.
  if (candidates.length === 0) return { src: base, srcset: null, width, height }
  const box = (w: number) => ({ w, h: Math.round(w / crop) })
  const srcset = candidates.map((w) => `${base}?w=${w}&h=${box(w).h} ${w}w`).join(', ')
  // Dimensions describe the resource actually in `src` — the largest rung —
  // so the reserved box carries the CROPPED ratio, not the source's.
  const largest = box(Math.max(...candidates))
  return {
    src: `${base}?w=${largest.w}&h=${largest.h}`,
    srcset,
    width: largest.w,
    height: largest.h,
  }
}

/**
 * Loading control: either the `priority` shorthand OR the native attributes it
 * stands for, never both — `<Image priority loading="lazy">` has no defensible
 * meaning, so the type refuses it instead of resolving it silently.
 *
 * `priority` earns its place by teaching: it says "there is one image on this
 * page worth flagging", which two independent attributes don't. But it bakes
 * in a hero-shaped assumption — a thumbnail grid wants the whole first row
 * eager with only the first at high priority, which the rollup cannot express.
 * So the underlying attributes are first-class, typed exactly as
 * `HTMLAttributes<'img'>` types them (native names, native enums).
 */
export type ImageLoading =
  | { priority?: boolean; loading?: never; fetchpriority?: never }
  | {
      priority?: never
      loading?: 'eager' | 'lazy'
      fetchpriority?: 'high' | 'low' | 'auto'
    }

export type ImageProps = GetImageOptions &
  ImageLoading & {
    /** Required — an image without alt text is a compile error on purpose.
     *  Decorative images say so explicitly with `alt=""`. */
    alt: string
    sizes?: string
    /** Orthogonal to the priority question, so it sits outside that union —
     *  folding it in would repeat the over-coupling one level up. */
    decoding?: 'sync' | 'async' | 'auto'
    class?: string
  }

export function Image(props: ImageProps): HtmlFragment {
  const {
    alt,
    class: className,
    sizes = '100vw',
    priority,
    loading = priority ? 'eager' : 'lazy',
    fetchpriority = priority ? 'high' : undefined,
    decoding = 'async',
  } = props
  const img = getImage(props)
  return html`<img
    src="${img.src}"
    srcset="${img.srcset ?? undefined}"
    sizes="${img.srcset ? sizes : undefined}"
    alt="${alt}"
    width="${img.width}"
    height="${img.height}"
    loading="${loading}"
    fetchpriority="${fetchpriority}"
    decoding="${decoding}"
    class="${className}"
  />`
}

/** An art-directed source: under `media`, serve a different GEOMETRY — the
 *  `crop` ratio the endpoint cover-crops to, same vocabulary and same
 *  allowlist as the plain `crop` prop. Reach for `sources` when the geometry
 *  VARIES by breakpoint; a single fixed crop is just `crop` on the component. */
export interface PictureSource {
  media: string
  /** width / height of the crop. `1` = square, `16 / 9` = widescreen. */
  crop: number
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

export function Picture(props: PictureProps): HtmlFragment {
  const { formats = ['avif', 'webp'], sources: artSources = [], sizes = '100vw', ...rest } = props
  // The fallback <img> is built from the same props the sources were — `crop`
  // included, so its reserved box describes the cropped output rather than the
  // source's own shape.
  const imageProps = { ...rest, sizes } as ImageProps
  if (isRemote(rest.src)) return Image(imageProps)

  const storedExt = rest.src.slice(rest.src.lastIndexOf('.') + 1).toLowerCase() as ImageFormat

  // Art-directed sources come FIRST (the browser takes the first media+type
  // match), each crossed with every modern format plus the stored format —
  // without the stored-format row, a browser supporting none of the modern
  // formats would fall past the media condition to the uncropped fallback.
  // Cropping is just `getImage` with a different `crop`, so art direction and
  // the plain chain share one code path.
  const art = artSources.flatMap((source) =>
    [...formats, storedExt]
      .filter((f, i, all) => all.indexOf(f) === i && f in SOURCE_TYPES)
      .map((format) => ({
        media: source.media,
        format: format as ImageFormat,
        srcset: getImage({
          ...imageProps,
          format: format as ImageFormat,
          crop: source.crop,
          widths: source.widths ?? rest.widths,
        }).srcset,
        sizes: source.sizes ?? sizes,
      }))
      .filter((s) => s.srcset !== null),
  )
  const plain = formats
    .map((format) => ({
      media: undefined,
      format,
      srcset: getImage({ ...imageProps, format }).srcset,
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
