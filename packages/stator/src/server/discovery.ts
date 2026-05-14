import { readdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isStatorMachine, type MachineDef } from './define-machine.ts'

export interface DiscoveryResult {
  defs: MachineDef<any, any>[]
}

export async function discoverMachines(dir: string): Promise<DiscoveryResult> {
  const absDir = resolve(dir)
  const entries = await readdir(absDir, { withFileTypes: true })

  const files: string[] = []
  for (const e of entries) {
    if (e.isFile() && (extname(e.name) === '.ts' || extname(e.name) === '.js')) {
      files.push(resolve(absDir, e.name))
    }
  }

  const defs: MachineDef<any, any>[] = []
  const seenNames = new Set<string>()

  for (const file of files) {
    const mod = await import(pathToFileURL(file).href)
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

function validateReads(defs: MachineDef<any, any>[], dir: string): void {
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

function topoSort(defs: MachineDef<any, any>[]): MachineDef<any, any>[] {
  const sorted: MachineDef<any, any>[] = []
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<MachineDef<any, any>, number>()
  for (const d of defs) color.set(d, WHITE)

  const path: MachineDef<any, any>[] = []

  const visit = (def: MachineDef<any, any>): void => {
    const c = color.get(def) ?? WHITE
    if (c === BLACK) return
    if (c === GRAY) {
      const startIdx = path.findIndex((d) => d === def)
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
