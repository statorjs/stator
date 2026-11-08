/**
 * The project's own install of `@statorjs/stator`: which release it is and
 * whether it speaks the editor contract (exports `@statorjs/stator/editor`).
 *
 * The extension bundles a compiler, but the API it shows must follow the
 * project, not the extension (see `@statorjs/stator/editor`). This reads the
 * installed `package.json` directly, walking up from the file like Node's
 * resolver does. `require.resolve` is no use here: the package's `exports`
 * map does not expose `package.json`.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ProjectStator {
  /** The installed package's directory. */
  root: string
  version: string
  /** Whether it exports `@statorjs/stator/editor`. */
  editorContract: boolean
}

const parsed = new Map<string, { mtimeMs: number; info: ProjectStator }>()

/** The `@statorjs/stator` a file at `filePath` would import, or undefined when
 *  none is installed above it. Re-read when its `package.json` changes, so an
 *  upgrade mid-session is picked up on the next edit. */
export function findProjectStator(filePath: string): ProjectStator | undefined {
  let dir = dirname(filePath)
  for (;;) {
    const root = join(dir, 'node_modules', '@statorjs', 'stator')
    const pkgPath = join(root, 'package.json')
    const stat = statSync(pkgPath, { throwIfNoEntry: false })
    if (stat) return read(pkgPath, root, stat.mtimeMs)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function read(pkgPath: string, root: string, mtimeMs: number): ProjectStator | undefined {
  const hit = parsed.get(pkgPath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.info
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string
      exports?: Record<string, unknown>
    }
    const info: ProjectStator = {
      root,
      version: pkg.version ?? '0.0.0',
      editorContract: pkg.exports?.['./editor'] !== undefined,
    }
    parsed.set(pkgPath, { mtimeMs, info })
    return info
  } catch {
    return undefined
  }
}
