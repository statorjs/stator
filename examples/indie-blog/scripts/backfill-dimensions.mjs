/**
 * One-shot: probe intrinsic dimensions for photo posts published before the
 * dimensions columns existed (their rows carry NULLs, so `<Image>` can't
 * reserve the aspect-ratio box and the layout jumps on first load).
 *
 *   pnpm exec tsx scripts/backfill-dimensions.mjs   (tsx: plain node cannot import the raw-TS framework)
 */
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { probeImage } from '@statorjs/stator/server'

const db = new DatabaseSync(process.env.INDIE_BLOG_DB ?? 'indie-blog.db')
const mediaDir = resolve(process.env.INDIE_BLOG_MEDIA ?? 'media')
const rows = db
  .prepare('SELECT slug, photo_path FROM posts WHERE photo_path IS NOT NULL AND photo_width IS NULL')
  .all()

for (const row of rows) {
  try {
    const { readFile } = await import('node:fs/promises')
    const meta = await probeImage(new Uint8Array(await readFile(join(mediaDir, row.photo_path))))
    db.prepare('UPDATE posts SET photo_width = ?, photo_height = ? WHERE slug = ?').run(
      meta.width,
      meta.height,
      row.slug,
    )
    console.log(`${row.slug}: ${meta.width}x${meta.height}`)
  } catch (err) {
    console.warn(`${row.slug}: skipped (${err.message})`)
  }
}
console.log(`backfilled ${rows.length} post(s)`)
