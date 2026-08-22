import { relative } from 'node:path'

/**
 * The identity a `.stator` file compiles under, derived from its path relative
 * to the app (or dist) root: `id` seeds the scope hash and labels diagnostics,
 * `kind` selects the route-page vs component capability set. Every compile
 * path — `buildApp`, the native dev server's CSS scan, and the dev loader — must
 * agree on this, or markup compiled on one thread won't match CSS scoped on
 * another. Always `/`-separated so ids (and manifest keys) are stable across
 * operating systems.
 */
export function sourceId(base: string, file: string): { id: string; kind: 'route' | 'component' } {
  const id = relative(base, file).replace(/\\/g, '/')
  return { id, kind: /(^|\/)routes\//.test(id) ? 'route' : 'component' }
}
