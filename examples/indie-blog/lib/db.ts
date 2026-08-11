import { DatabaseSync } from 'node:sqlite'

/**
 * Posts live in a real database, not a machine — the where-data-lives rule.
 * A blog's archive is reference data: nothing re-renders against the whole
 * set, and it grows without bound. Machines hold the REACTIVE state around
 * it (mention workflows, the outbox). node:sqlite's synchronous API fits the
 * synchronous-frontmatter contract, so routes read posts directly.
 *
 * (Requires Node 24+, matching the with-auth example.)
 */

export type PostKind = 'note' | 'article'

export interface PostRow {
  id: string
  slug: string
  kind: PostKind
  /** Articles have a title. Notes don't — that IS the post-type-discovery
   *  rule: named content is an article, unnamed content is a note. */
  title: string | null
  /** Plain text. Paragraphs split on blank lines, URLs autolink at render.
   *  Bring your own markdown renderer if you want one — the starter stays
   *  dependency-free on purpose. */
  content: string
  published_at: number
  updated_at: number
}

let db: DatabaseSync | null = null

function conn(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(process.env.INDIE_BLOG_DB ?? 'indie-blog.db')
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id           TEXT PRIMARY KEY,
      slug         TEXT NOT NULL UNIQUE,
      kind         TEXT NOT NULL,
      title        TEXT,
      content      TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `)
  return db
}

/** Test hook: close and forget the connection so a fresh INDIE_BLOG_DB applies. */
export function resetDb(): void {
  db?.close()
  db = null
}

export function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function listPosts(limit = 50): PostRow[] {
  return conn()
    .prepare('SELECT * FROM posts ORDER BY published_at DESC LIMIT ?')
    .all(limit) as unknown as PostRow[]
}

export function postBySlug(slug: string): PostRow | null {
  return (conn().prepare('SELECT * FROM posts WHERE slug = ?').get(slug) ?? null) as PostRow | null
}

export function createPost(p: Omit<PostRow, 'id' | 'published_at' | 'updated_at'>): PostRow {
  const now = Date.now()
  const row: PostRow = { id: genId(), published_at: now, updated_at: now, ...p }
  conn()
    .prepare(
      'INSERT INTO posts (id, slug, kind, title, content, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(row.id, row.slug, row.kind, row.title, row.content, row.published_at, row.updated_at)
  return row
}

export function updatePost(slug: string, fields: { title: string | null; content: string }): void {
  conn()
    .prepare('UPDATE posts SET title = ?, content = ?, updated_at = ? WHERE slug = ?')
    .run(fields.title, fields.content, Date.now(), slug)
}

export function deletePost(slug: string): void {
  conn().prepare('DELETE FROM posts WHERE slug = ?').run(slug)
}
