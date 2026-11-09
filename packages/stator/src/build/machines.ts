import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { importsIn, type ModuleImport, parseModule, probeModule } from './imports.ts'

/**
 * What a server machine module is, for every place that keeps one out of a
 * browser bundle: a module that imports `defineMachine` from where Stator
 * exports it, by any static form, read through the TypeScript API.
 *
 * Where Stator exports it: `@statorjs/stator/server` and
 * `@statorjs/stator/machine`, or a relative path into this package's own
 * `src/server/` or `src/engine/`. A local module that re-exports
 * `defineMachine` from one of those counts too, one level deep. Stator's own
 * modules are never machine modules (`client/machine.ts` builds client
 * machines on the engine's `defineMachine`).
 *
 * The forms: `import { defineMachine }`, `import { defineMachine as dm }`, and
 * `import * as S` used as `S.defineMachine`.
 */

const DEFINER_SPECS = new Set(['@statorjs/stator/server', '@statorjs/stator/machine'])

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const STATOR_SRC = real(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const DEFINER_DIRS = ['server', 'engine'].map((d) => resolve(STATOR_SRC, d))

const sep = /[\\/]/
const inDir = (dir: string, file: string): boolean =>
  file.startsWith(dir) && sep.test(file.charAt(dir.length))

function target(spec: string, importer: string): string | undefined {
  if (!spec.startsWith('.') && !isAbsolute(spec)) return undefined
  return probeModule(resolve(dirname(importer), spec))
}

/** Whether `spec`, imported from `importer`, is a module Stator exports
 *  `defineMachine` from. */
function isDefiner(spec: string, importer: string): boolean {
  if (DEFINER_SPECS.has(spec)) return true
  const file = target(spec, importer)
  if (!file) return false
  const abs = real(file)
  return DEFINER_DIRS.some((d) => inDir(d, abs))
}

function read(file: string): ts.SourceFile | undefined {
  try {
    return parseModule(readFileSync(file, 'utf8'), file)
  } catch {
    return undefined
  }
}

/** Whether the local module at `file` re-exports `defineMachine` from a definer. */
function reExportsDefineMachine(file: string): boolean {
  const sf = read(file)
  if (!sf) return false
  return importsIn(sf).some(
    (imp) =>
      imp.kind === 'export' &&
      !imp.typeOnly &&
      (imp.exportStar || imp.named.some((n) => !n.typeOnly && n.local === 'defineMachine')) &&
      isDefiner(imp.spec, file),
  )
}

/** Whether `imp` brings `defineMachine` into the module at `file`. */
function bringsDefineMachine(imp: ModuleImport, file: string, sf: ts.SourceFile): boolean {
  if (imp.kind !== 'import' || imp.typeOnly) return false
  const named = imp.named.some((n) => !n.typeOnly && n.imported === 'defineMachine')
  if (!named && !imp.namespace) return false
  const fromDefiner = (): boolean => {
    if (isDefiner(imp.spec, file)) return true
    const local = target(imp.spec, file)
    return local !== undefined && reExportsDefineMachine(local)
  }
  if (named) return fromDefiner()
  return usesMember(sf, imp.namespace!, 'defineMachine') && fromDefiner()
}

function usesMember(sf: ts.SourceFile, object: string, member: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === object &&
      node.name.text === member
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/

const verdicts = new Map<string, { mtimeMs: number; machine: boolean }>()

/** Whether `file` is a server machine module. Read as text, so a client helper
 *  that touches browser globals is never imported in Node to find out. */
export function isServerMachineModule(file: string): boolean {
  if (!CODE.test(file) || inDir(STATOR_SRC, real(file))) return false
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) return false
  const hit = verdicts.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.machine
  const sf = read(file)
  const machine = sf ? importsIn(sf).some((imp) => bringsDefineMachine(imp, file, sf)) : false
  verdicts.set(file, { mtimeMs: stat.mtimeMs, machine })
  return machine
}

/**
 * The `name` of the machine `file` default-exports, read by importing it in
 * Node. Fails, naming the file and `context` (who is stubbing it), when the
 * import throws or the default export carries no string `name`.
 */
export async function machineName(file: string, context: string): Promise<string> {
  let mod: { default?: { name?: unknown } }
  try {
    mod = (await import(pathToFileURL(file).href)) as typeof mod
  } catch (err) {
    throw new Error(`${context}: importing ${file} in Node failed: ${(err as Error).message}`)
  }
  const name = mod.default?.name
  if (typeof name !== 'string') {
    throw new Error(
      `${context}: ${file} does not default-export a machine with a string name, so it cannot be ` +
        'stubbed for the browser.',
    )
  }
  return name
}
