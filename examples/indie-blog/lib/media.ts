/**
 * Media storage — original photo bytes on disk, OUTSIDE `static/` on purpose:
 * production rebuilds recreate `dist/static`, so runtime-written files need a
 * data directory of their own, exactly like the SQLite file. Paths are dated
 * (`YYYY/MM/slug.ext`) and served by `routes/media/[...path].ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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

/** Write the original under a dated path; returns the media-relative path. */
export async function saveOriginal(file: File, slug: string): Promise<string> {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const rel = `${now.getFullYear()}/${month}/${slug}.${EXT_BY_TYPE[file.type]}`
  const full = join(mediaDir(), rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, new Uint8Array(await file.arrayBuffer()))
  return rel
}

/** Containment-checked absolute path for a media-relative request path, or
 *  null when the path escapes the media dir or has no known extension. */
export function mediaFile(rel: string): { full: string; contentType: string } | null {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  const contentType = CONTENT_TYPE_BY_EXT[ext]
  if (!contentType) return null
  const dir = mediaDir()
  const full = resolve(dir, rel)
  if (full !== dir && !full.startsWith(dir + sep)) return null
  return { full, contentType }
}
