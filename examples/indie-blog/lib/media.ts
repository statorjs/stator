/**
 * Media storage — original photo bytes on disk, OUTSIDE `static/` on purpose:
 * production rebuilds recreate `dist/static`, so runtime-written files need a
 * data directory of their own, exactly like the SQLite file. Paths are dated
 * (`YYYY/MM/slug.ext`) and served by `routes/media/[...path].ts`.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/** Extension by MIME type — the upload allowlist. Anything else is rejected. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

export const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
}

export function mediaDir(): string {
  return resolve(process.env.INDIE_BLOG_MEDIA ?? 'media')
}

export function photoError(file: File, alt: string): string | null {
  if (!EXT_BY_TYPE[file.type]) return 'Photos must be JPEG, PNG, WebP, AVIF, or GIF.'
  if (file.size > MAX_PHOTO_BYTES) return 'Photos fit in 10MB.'
  if (alt.trim() === '') return 'A photo needs alt text.'
  return null
}

/** Write the original under a dated path; returns the media-relative path
 *  plus intrinsic dimensions, probed once here — write-time data, so renders
 *  never do image IO. */
export async function saveOriginal(
  file: File,
  slug: string,
): Promise<{ rel: string; width: number | null; height: number | null }> {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const rel = `${now.getFullYear()}/${month}/${slug}.${EXT_BY_TYPE[file.type]}`
  const full = join(mediaDir(), rel)
  mkdirSync(dirname(full), { recursive: true })
  const bytes = new Uint8Array(await file.arrayBuffer())
  writeFileSync(full, bytes)
  const { default: sharp } = await import('sharp')
  const meta = await sharp(bytes).metadata()
  return { rel, width: meta.width ?? null, height: meta.height ?? null }
}

/** Widths the variant endpoint will produce — an allowlist, because an open
 *  `?w=` parameter is a resize-yourself-to-death invitation. */
export const VARIANT_WIDTHS = [400, 800, 1200, 1600]

/** Formats the endpoint will transcode TO. GIF is excluded both ways —
 *  animation doesn't survive naive resizing; GIFs serve as originals only. */
const VARIANT_FORMATS = new Set(['jpg', 'webp', 'avif', 'png'])

/** Find the stored original for a requested media path, whatever its
 *  extension: `/media/2026/08/x.webp` finds `x.jpg` if that's what was
 *  uploaded. The URL's extension is the delivery format — the server never
 *  lies about an extension; it converts to honor it. */
export function resolveOriginal(rel: string): { full: string; ext: string } | null {
  const dot = rel.lastIndexOf('.')
  if (dot === -1) return null
  const base = rel.slice(0, dot)
  const dir = mediaDir()
  for (const ext of Object.keys(CONTENT_TYPE_BY_EXT)) {
    const full = resolve(dir, `${base}.${ext}`)
    if (!full.startsWith(dir + sep)) return null
    if (existsSync(full)) return { full, ext }
  }
  return null
}

/**
 * Produce (or reuse) a variant: the requested extension is the output format,
 * `width` resizes without enlargement. Cached on disk beside the originals
 * (`.variants/`), regenerated when the original is newer than the cache.
 */
export async function variantFile(
  rel: string,
  width: number | null,
): Promise<{ full: string; contentType: string } | null> {
  const dot = rel.lastIndexOf('.')
  const requestedExt = rel.slice(dot + 1).toLowerCase()
  const contentType = CONTENT_TYPE_BY_EXT[requestedExt]
  if (!contentType) return null
  if (width !== null && !VARIANT_WIDTHS.includes(width)) return null

  const original = resolveOriginal(rel)
  if (!original) return null

  // Original passthrough: same extension as stored, no resize requested.
  if (original.ext === requestedExt && width === null) {
    return { full: original.full, contentType }
  }
  // GIFs (either direction) don't transcode — serve the original only.
  if (!VARIANT_FORMATS.has(requestedExt) || original.ext === 'gif') return null

  const cacheRel = `.variants/${rel.slice(0, dot)}-${width ?? 'orig'}.${requestedExt}`
  const cache = join(mediaDir(), cacheRel)
  const fresh =
    existsSync(cache) && statSync(cache).mtimeMs >= statSync(original.full).mtimeMs
  if (!fresh) {
    const { default: sharp } = await import('sharp')
    let pipeline = sharp(original.full)
    if (width !== null) pipeline = pipeline.resize({ width, withoutEnlargement: true })
    const format = requestedExt === 'jpg' ? 'jpeg' : requestedExt
    mkdirSync(dirname(cache), { recursive: true })
    await pipeline.toFormat(format as 'jpeg' | 'webp' | 'avif' | 'png').toFile(cache)
  }
  return { full: cache, contentType }
}

