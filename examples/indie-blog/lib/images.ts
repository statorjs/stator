/**
 * `getImage()` — resolve a stored photo to final markup attributes. Pure math
 * over write-time data (the intrinsic dimensions probed at upload): no IO, no
 * async, so it runs in synchronous frontmatter and components. The API
 * direction follows Astro's first image integration: a lib function the
 * components wrap, so custom markup can always drop down a level.
 */
import { VARIANT_WIDTHS } from './media.ts'

export type ImageFormat = 'jpg' | 'webp' | 'avif' | 'png'

export interface GetImageOptions {
  /** Media-relative stored path (`2026/08/slug.jpg`). */
  src: string
  /** Intrinsic dimensions from the post row (write-time probe). */
  width: number | null
  height: number | null
  /** Delivery format — defaults to the stored extension. */
  format?: ImageFormat
  /** Candidate widths for `srcset`; filtered to the endpoint's allowlist and
   *  to widths not exceeding the intrinsic width. */
  widths?: number[]
}

export interface ResolvedImage {
  src: string
  srcset: string | null
  width: number | null
  height: number | null
}

const url = (path: string, format: string | undefined, w?: number): string => {
  const dot = path.lastIndexOf('.')
  const withFormat = format ? `${path.slice(0, dot)}.${format}` : path
  return `/media/${withFormat}${w ? `?w=${w}` : ''}`
}

export function getImage(opts: GetImageOptions): ResolvedImage {
  const { src, width, height, format } = opts
  const storedExt = src.slice(src.lastIndexOf('.') + 1).toLowerCase()
  // GIFs serve as originals only (animation doesn't survive naive resizing).
  if (storedExt === 'gif') {
    return { src: url(src, undefined), srcset: null, width, height }
  }
  const candidates = (opts.widths ?? VARIANT_WIDTHS).filter(
    (w) => VARIANT_WIDTHS.includes(w) && (width === null || w < width),
  )
  const srcset =
    candidates.length > 0
      ? candidates.map((w) => `${url(src, format, w)} ${w}w`).join(', ')
      : null
  return { src: url(src, format), srcset, width, height }
}
