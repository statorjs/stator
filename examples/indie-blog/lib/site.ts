import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Site-wide config from the environment, with dev defaults. */

/** Absolute origin this site is served from — webmention targets must live
 *  under it, and outgoing mentions cite post URLs built on it. */
export const SITE_ORIGIN = (process.env.INDIE_BLOG_ORIGIN ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
)

export const SITE_NAME = process.env.INDIE_BLOG_NAME ?? 'An Indie Blog'
export const AUTHOR_NAME = process.env.INDIE_BLOG_AUTHOR ?? 'The Author'

/** Extra webmention targets every published post also notifies — this is how
 *  Bridgy-style syndication works: brid.gy publish endpoints are ordinary
 *  webmention receivers that fan the post out to silos. Comma-separated. */
export const SYNDICATION_TARGETS = (process.env.INDIE_BLOG_SYNDICATE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')

/**
 * Single-owner auth: the password comes from the environment and is hashed
 * once at boot; logins verify against the hash (scrypt via node:crypto, no
 * dependency — the with-auth example's idiom). Self-hosted single-user
 * trade-off, stated plainly: the env var holds the plaintext. The dev
 * default is for local play only.
 */
const OWNER_PASSWORD = process.env.INDIE_BLOG_PASSWORD ?? 'owls-at-dusk'
const salt = randomBytes(16).toString('hex')
const hash = scryptSync(OWNER_PASSWORD, salt, 64)

export function verifyOwnerPassword(plaintext: string): boolean {
  const actual = scryptSync(plaintext, salt, 64)
  return actual.length === hash.length && timingSafeEqual(actual, hash)
}

export function postUrl(slug: string): string {
  return `${SITE_ORIGIN}/posts/${slug}`
}

/** The slug a webmention target URL points at, or null if it isn't a post
 *  URL on this site. */
export function slugOfTarget(target: string): string | null {
  const prefix = `${SITE_ORIGIN}/posts/`
  if (!target.startsWith(prefix)) return null
  const slug = target.slice(prefix.length).replace(/\/$/, '')
  return /^[a-z0-9-]+$/.test(slug) ? slug : null
}
