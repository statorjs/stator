/**
 * Media ingestion — the upload half only. Serving (originals, on-demand
 * variants, conditional GET) is the framework's image endpoint, configured in
 * `stator.config.ts`; this file owns what stays app code: validation, where
 * bytes land, and the write-time dimensions probe.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { probeImage } from '@statorjs/stator/server'

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024

/** Extension by MIME type — the upload allowlist. Anything else is rejected. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

export function mediaDir(): string {
  return resolve(process.env.INDIE_BLOG_MEDIA ?? 'media')
}

/** Returns an error CODE (`photo-type` / `photo-size` / `photo-alt`) so the
 *  desk can show the specific problem — a blank alt field shouldn't read like
 *  a format rejection. */
export function photoError(file: File, alt: string): string | null {
  if (!EXT_BY_TYPE[file.type]) return 'photo-type'
  if (file.size > MAX_PHOTO_BYTES) return 'photo-size'
  if (alt.trim() === '') return 'photo-alt'
  return null
}

/** Write the original under a dated path; returns the media-relative path
 *  plus intrinsic dimensions probed once here — write-time data, so renders
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
  const { width, height } = await probeImage(bytes)
  return { rel, width, height }
}
