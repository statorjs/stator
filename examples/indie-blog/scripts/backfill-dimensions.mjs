/**
 * One-shot: probe intrinsic dimensions for photo posts published before the
 * dimensions columns existed (their rows carry NULLs, so `<Image>` can't
 * reserve the aspect-ratio box and the layout jumps on first load).
 *
 *   node scripts/backfill-dimensions.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const db = new DatabaseSync(process.env.INDIE_BLOG_DB ?? 'indie-blog.db')
const mediaDir = resolve(process.env.INDIE_BLOG_MEDIA ?? 'media')
const rows = db
  .prepare('SELECT slug, photo_path FROM posts WHERE photo_path IS NOT NULL AND photo_width IS NULL')
  .all()

for (const row of rows) {
  try {
    const meta = await sharp(join(mediaDir, row.photo_path)).metadata()
    db.prepare('UPDATE posts SET photo_width = ?, photo_height = ? WHERE slug = ?').run(
      meta.width ?? null,
      meta.height ?? null,
      row.slug,
    )
    console.log(`${row.slug}: ${meta.width}x${meta.height}`)
  } catch (err) {
    console.warn(`${row.slug}: skipped (${err.message})`)
  }
}
console.log(`backfilled ${rows.length} post(s)`)
