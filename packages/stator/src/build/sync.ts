import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { generateDts } from '../compiler/dts.ts'

/**
 * Type sync: walk an app's `.stator` files and write a sibling
 * `<name>.stator.d.ts` for each component, so `tsc`/editors type
 * `import X from './x.stator'` against the component's real props (the `.d.ts`
 * beats the `*.stator` ambient wildcard). Route pages (`routes/*.stator`) are
 * skipped — they export `GET`, not a render function.
 *
 * Runs as a one-shot `stator sync` step before `tsc`, and on `.stator` change in
 * a dev watch.
 */
export interface SyncResult {
  /** Number of `.stator.d.ts` files written. */
  written: number
}

export async function syncTypes(root: string): Promise<SyncResult> {
  const files = await walk(root)
  let written = 0
  for (const file of files) {
    const kind = file.split(sep).includes('routes') ? 'route' : 'component'
    const dts = generateDts(await readFile(file, 'utf8'), { kind })
    if (dts === null) continue
    await writeFile(file + '.d.ts', dts)
    written++
  }
  return { written }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
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
