import { DatabaseSync } from 'node:sqlite'

/**
 * User accounts live in a real database, not a machine — machines hold live
 * REACTIVE state (session identity, the notice board); accounts are
 * REFERENCE data that nothing re-renders against. node:sqlite's synchronous
 * API is a perfect fit: guards and route frontmatter are synchronous by
 * contract, and can call these helpers directly.
 *
 * (Requires Node 24+. Swap for better-sqlite3 on older Node.)
 */

export interface UserRow {
  id: string
  email: string
  name: string
  role: 'member' | 'harbormaster'
  pass_salt: string
  pass_hash: string
}

const dbPath = process.env.WITH_AUTH_DB ?? new URL('../harbor.db', import.meta.url).pathname
const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    pass_salt  TEXT NOT NULL,
    pass_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`)

export function findUserByEmail(email: string): UserRow | undefined {
  return db
    .prepare('SELECT id, email, name, role, pass_salt, pass_hash FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as UserRow | undefined
}

export function findUserById(id: string): UserRow | undefined {
  return db
    .prepare('SELECT id, email, name, role, pass_salt, pass_hash FROM users WHERE id = ?')
    .get(id) as UserRow | undefined
}

export function createUser(row: Omit<UserRow, 'role'> & { role?: UserRow['role'] }): void {
  db.prepare(
    'INSERT INTO users (id, email, name, role, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.email.trim().toLowerCase(), row.name, row.role ?? 'member', row.pass_salt, row.pass_hash, Date.now())
}

export function updateUserName(id: string, name: string): void {
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id)
}
