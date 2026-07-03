import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { generateDts } from '../compiler/dts.ts'

/**
 * Type sync: generate a `<name>.stator.d.ts` for each component so editors and
 * `tsc` type `import X from './x.stator'` against the component's real props
 * (the `.d.ts` beats the `*.stator` ambient wildcard).
 *
 * The generated files live in a hidden, framework-managed `.stator/types/`
 * directory that MIRRORS the source tree — never next to source. TS finds them
 * via `rootDirs: ['.', '.stator/types']` in the app's tsconfig, which merges the
 * two trees into one virtual root (the Astro `.astro/` / SvelteKit `.svelte-kit/`
 * convention). `.stator/` is gitignored.
 *
 * Route pages (`routes/*.stator`) are skipped — they export `GET`, not a render
 * function.
 */
export interface SyncResult {
  /** Number of `.stator.d.ts` files written. */
  written: number
  /** The generated-types directory. */
  outDir: string
}

const TYPES_DIR = join('.stator', 'types')

export async function syncTypes(root: string): Promise<SyncResult> {
  const outDir = join(root, TYPES_DIR)
  await rm(outDir, { recursive: true, force: true })

  const files = await walk(root)
  let written = 0
  for (const file of files) {
    const kind = file.split(sep).includes('routes') ? 'route' : 'component'
    const dts = generateDts(await readFile(file, 'utf8'), { kind })
    if (dts === null) continue
    // Mirror the source path under .stator/types: templates/x.stator →
    // .stator/types/templates/x.stator.d.ts.
    const rel = relative(root, file)
    const target = join(outDir, `${rel}.d.ts`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, dts)
    written++
  }
  return { written, outDir }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (e.name.endsWith('.stator')) out.push(full)
  }
  return out
}
