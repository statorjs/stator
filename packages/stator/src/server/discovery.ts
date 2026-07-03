import { readdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type AnyMachineDef, isStatorMachine } from './define-machine.ts'

export interface DiscoveryResult {
  defs: AnyMachineDef[]
}

/** How a discovered file is turned into a module. Defaults to native dynamic
 *  import; the dev server injects Vite's `ssrLoadModule` so `.stator` imports
 *  (and TS) are compiled on the way in. */
export type ModuleLoader = (file: string) => Promise<Record<string, unknown>>

const nativeLoader: ModuleLoader = (file) => import(/* @vite-ignore */ pathToFileURL(file).href)

export async function discoverMachines(
  dir: string,
  load: ModuleLoader = nativeLoader,
): Promise<DiscoveryResult> {
  const absDir = resolve(dir)
  // A missing conventional dir means "no machines yet" (e.g. early in a fresh
  // project), not an error. A *present* file that isn't a machine still throws
  // below — that's a real mistake, not an absence.
  const entries = await readdir(absDir, { withFileTypes: true }).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return []
      throw e
    },
  )

  const files: string[] = []
  for (const e of entries) {
    if (e.isFile() && (extname(e.name) === '.ts' || extname(e.name) === '.js')) {
      files.push(resolve(absDir, e.name))
    }
  }

  const defs: AnyMachineDef[] = []
  const seenNames = new Set<string>()

  for (const file of files) {
    const mod = await load(file)
    const def = mod.default
    if (!isStatorMachine(def)) {
      throw new Error(
        `stator: ${file} default export is not a stator machine. ` +
          `Did you forget to call defineMachine()?`,
      )
    }
    if (seenNames.has(def.name)) {
      throw new Error(`stator: duplicate machine name "${def.name}" in ${file}`)
    }
    seenNames.add(def.name)
    defs.push(def)
  }

  validateReads(defs, absDir)

  return { defs: topoSort(defs) }
}

function validateReads(defs: AnyMachineDef[], dir: string): void {
  const byName = new Map(defs.map((d) => [d.name, d]))
  for (const def of defs) {
    for (const dep of def.reads) {
      if (!byName.has(dep.name)) {
        throw new Error(
          `stator: machine "${def.name}" reads from "${dep.name}", which was not ` +
            `discovered in ${dir}. Both must live in the machines directory.`,
        )
      }
      if (def.lifecycle === 'app' && dep.lifecycle === 'session') {
        throw new Error(
          `stator: app-lifecycle machine "${def.name}" cannot read session-lifecycle ` +
            `machine "${dep.name}". App machines exist before any session.`,
        )
      }
    }
  }
}

function topoSort(defs: AnyMachineDef[]): AnyMachineDef[] {
  const sorted: AnyMachineDef[] = []
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<AnyMachineDef, number>()
  for (const d of defs) color.set(d, WHITE)

  const path: AnyMachineDef[] = []

  const visit = (def: AnyMachineDef): void => {
    const c = color.get(def) ?? WHITE
    if (c === BLACK) return
    if (c === GRAY) {
      const startIdx = path.indexOf(def)
      const cycle = [...path.slice(startIdx), def].map((d) => d.name).join(' -> ')
      throw new Error(`stator: dependency cycle detected: ${cycle}`)
    }
    color.set(def, GRAY)
    path.push(def)
    for (const dep of def.reads) visit(dep)
    path.pop()
    color.set(def, BLACK)
    sorted.push(def)
  }

  for (const def of defs) visit(def)
  return sorted
}
