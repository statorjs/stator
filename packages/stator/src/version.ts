import { readFileSync } from 'node:fs'

let cached: string | undefined

/** The installed `@statorjs/stator` version, read once from its package.json. */
export function statorVersion(): string {
  if (cached === undefined) {
    try {
      cached = String(
        (
          JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
            version?: unknown
          }
        ).version ?? '',
      )
    } catch {
      cached = ''
    }
  }
  return cached
}
