import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { scanRegions } from '../compiler/split.ts'
import { importsIn, type ModuleImport, parseModule, probeModule } from './imports.ts'

/**
 * Machine modules, and what an island does with one.
 *
 * A machine module is a module that imports `defineMachine` from where Stator
 * exports it, by any static form, read through the TypeScript API. Nothing in
 * it says where it runs: the same definition can be registered on the server,
 * run in an island and tested in Node. What an island's script does with the
 * import decides what its bundle gets (`machineImportUse`): the machine's
 * code when the script runs it, or the `{ name }` that `dispatch()` addresses.
 *
 * Where Stator exports it: `@statorjs/stator/machine`, or a relative path
 * into this package's own `src/server/` or `src/engine/` (its own fixtures). A local module that re-exports
 * `defineMachine` from one of those counts too, one level deep. Stator's own
 * modules are never machine modules (`client/machine.ts` builds client
 * machines on the engine's `defineMachine`).
 *
 * The forms: `import { defineMachine }`, `import { defineMachine as dm }`, and
 * `import * as S` used as `S.defineMachine`.
 */

const DEFINER_SPECS = new Set(['@statorjs/stator/machine'])

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

/** Whether `file` is a machine module. Read as text, so a client helper that
 *  touches browser globals is never imported in Node to find out. */
export function isMachineModule(file: string): boolean {
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

/** The script a module runs in the browser, parsed, with each region's offset
 *  in the file: a `.stator` file's `<script>` regions, or the module itself. */
interface Region {
  sf: ts.SourceFile
  offset: number
}

const parsed = new Map<string, { mtimeMs: number; text: string; regions: Region[] }>()

function scriptRegions(importer: string): { text: string; regions: Region[] } {
  const none = { text: '', regions: [] }
  const stat = statSync(importer, { throwIfNoEntry: false })
  if (!stat?.isFile()) return none
  const hit = parsed.get(importer)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit
  let text = ''
  let regions: Region[] = []
  try {
    text = readFileSync(importer, 'utf8')
    if (importer.endsWith('.stator')) {
      regions = scanRegions(text).scripts.map((r) => ({
        sf: parseModule(r.content, `${importer}.ts`),
        offset: r.contentOffset,
      }))
    } else if (CODE.test(importer)) {
      regions = [{ sf: parseModule(text, importer), offset: 0 }]
    }
  } catch {
    regions = []
  }
  const entry = { mtimeMs: stat.mtimeMs, text, regions }
  parsed.set(importer, entry)
  return entry
}

/** `x`, through any `(x)`, `x as T`, `x satisfies T` or `x!` around it. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression
  }
  return cur
}

/**
 * What a script does with a machine module it imports.
 *
 * - `stub`: every use only addresses the machine (`dispatch(Cart, …)`,
 *   `Cart.name`), so the bundle gets its `{ name }` and none of its code.
 * - `real`: the script needs the module itself, so its code is bundled. `runs`
 *   lists the exports that reach `use()`, the ones that run in the browser.
 * - `error`: the script uses the import in a way that says neither.
 */
export type MachineImportUse =
  | { kind: 'stub' }
  | { kind: 'real'; runs: string[] }
  | { kind: 'error'; message: string }

export interface MachineImportOptions {
  /** The importer is itself a machine module (or sits in `machines/`): a use
   *  that says neither, such as `reads: [Prices]`, addresses the machine. */
  lenient?: boolean
  /** Paths in messages are shown relative to this directory. */
  root?: string
}

/** The export a factory's product stands for in `runs`: it runs in the
 *  browser, and there is no definition to check until it is called. */
const FACTORY = '(factory)'

/**
 * Read from the script at `importer` what it does with the module it imports
 * as `spec` (the specifier as written). `undefined` when no script region
 * imports it.
 *
 * The module is needed, and bundled, when the script:
 * - passes an import to `use()`, directly, through a `const` alias, or as the
 *   product of calling an import (a machine factory);
 * - calls an import, or reads a property of the default import other than
 *   `name`;
 * - takes a named or namespace import, or `import()`s the module.
 *
 * Otherwise only the default import is in play. When every use of it is
 * `dispatch(X, …)` or `X.name`, it is a stub. Any other use (an argument to
 * some other function, an array element, an export) cannot be placed: an error
 * in an island script or a helper, an address in a machine module.
 *
 * Matching is by name within the script, not by scope: a local that shadows
 * an import is read as the import.
 */
export function machineImportUse(
  importer: string,
  spec: string,
  opts: MachineImportOptions = {},
): MachineImportUse | undefined {
  // A compiled client entry with its `.stator` beside it (a library's) is
  // read from that source, so a message points at what the author wrote.
  const source = importer.replace(/\.stator\.client\.ts$/, '.stator')
  if (source !== importer) {
    const fromSource = machineImportUse(source, spec, opts)
    if (fromSource) return fromSource
  }
  const { text, regions } = scriptRegions(importer)
  const shown = opts.root ? relative(opts.root, importer).replace(/\\/g, '/') : importer
  let result: MachineImportUse | undefined
  for (const region of regions) {
    const use = regionUse(region, spec, opts.lenient ?? false, (pos) => {
      const line = text.slice(0, region.offset + pos).split('\n').length
      return `${shown}:${line}`
    })
    if (!use) continue
    if (use.kind === 'error') return use
    if (use.kind === 'real') {
      const runs = result?.kind === 'real' ? [...result.runs, ...use.runs] : use.runs
      result = { kind: 'real', runs: [...new Set(runs)] }
    } else if (!result) {
      result = use
    }
  }
  return result
}

function regionUse(
  { sf }: Region,
  spec: string,
  lenient: boolean,
  at: (pos: number) => string,
): MachineImportUse | undefined {
  /** Local name → the export it carries (`default`, or a named export). */
  const carries = new Map<string, string>()
  const namespaces = new Set<string>()
  let imported = false
  let needsModule = false
  let reExport: ModuleImport | undefined
  for (const imp of importsIn(sf)) {
    if (imp.spec !== spec) continue
    imported = true
    if (imp.typeOnly) continue
    if (imp.kind === 'export') {
      if (imp.exportStar || imp.namespace || imp.named.some((n) => !n.typeOnly)) reExport = imp
      continue
    }
    if (imp.kind !== 'import') {
      needsModule = true
      continue
    }
    if (imp.defaultName) carries.set(imp.defaultName, 'default')
    for (const n of imp.named) {
      if (n.typeOnly) continue
      carries.set(n.local, n.imported)
      needsModule = true
    }
    if (imp.namespace) {
      namespaces.add(imp.namespace)
      needsModule = true
    }
  }
  if (!imported) return undefined
  if (reExport) {
    if (lenient) return { kind: 'real', runs: [] }
    return {
      kind: 'error',
      message:
        `${at(reExport.start)} re-exports the machine module "${spec}". An island's bundle ` +
        'places a machine by what the importing script does with it, so import the machine ' +
        'module directly where it is used.',
    }
  }

  /** Locals holding what calling an import returned: a factory's machine. */
  const products = new Set<string>()
  const isImport = (node: ts.Expression): node is ts.Identifier =>
    ts.isIdentifier(node) && carries.has(node.text)
  const isNamespaceMember = (node: ts.Expression): node is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    namespaces.has(node.expression.text)
  /** A call of an import, or of a namespace member: `makeToggle('Menu')`. */
  const isFactoryCall = (node: ts.Expression): boolean => {
    if (!ts.isCallExpression(node)) return false
    const callee = unwrap(node.expression)
    return isImport(callee) || isNamespaceMember(callee)
  }

  // `const Menu = Cart` and `const Menu = makeToggle('Menu')`, to a fixpoint,
  // so an alias of an alias is followed.
  const declarations: ts.VariableDeclaration[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node)
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  for (let changed = true; changed; ) {
    changed = false
    for (const decl of declarations) {
      const name = (decl.name as ts.Identifier).text
      if (carries.has(name) || products.has(name)) continue
      const init = unwrap(decl.initializer!)
      if (isImport(init)) {
        carries.set(name, carries.get(init.text)!)
        changed = true
      } else if (isFactoryCall(init) || (ts.isIdentifier(init) && products.has(init.text))) {
        products.add(name)
        changed = true
      }
    }
  }

  const runs = new Set<string>()
  const placed = new Set<ts.Node>()
  let unplaced: ts.Identifier | undefined
  const tracked = (node: ts.Node): node is ts.Identifier =>
    ts.isIdentifier(node) && (carries.has(node.text) || products.has(node.text))

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      const first = node.arguments[0] ? unwrap(node.arguments[0]) : undefined
      if (callee === 'use' && first) {
        if (isImport(first)) {
          runs.add(carries.get(first.text)!)
          placed.add(first)
          needsModule = true
        } else if (ts.isIdentifier(first) && products.has(first.text)) {
          runs.add(FACTORY)
          placed.add(first)
        } else if (isFactoryCall(first)) {
          runs.add(FACTORY)
        } else if (isNamespaceMember(first)) {
          runs.add(first.name.text)
        }
      } else if (callee === 'dispatch' && first && tracked(first)) {
        placed.add(first)
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      if (isImport(callee)) {
        placed.add(callee)
        needsModule = true
      }
    }
    if (ts.isPropertyAccessExpression(node) && tracked(node.expression)) {
      placed.add(node.expression)
      if (node.name.text !== 'name') needsModule = true
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer)
      if (tracked(init)) placed.add(init)
    }

    if (tracked(node) && !placed.has(node) && !unplaced && isReference(node)) unplaced = node
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (needsModule) return { kind: 'real', runs: [...runs] }
  if (unplaced && !lenient) {
    return {
      kind: 'error',
      message:
        `${at(unplaced.getStart(sf))} uses the machine import "${unplaced.text}" from "${spec}" ` +
        'in a way the build cannot place. Pass it straight to use() to run it in the browser, ' +
        'or to dispatch() to address it on the server.',
    }
  }
  return { kind: 'stub' }
}

/** Whether `node` reads a binding, as opposed to naming a declaration, a
 *  property or a member. A shorthand property and a local export do read it. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) return true
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node
  if (ts.isQualifiedName(parent)) return false
  const named = parent as { name?: ts.Node }
  return named.name !== node
}

/**
 * Fail when an export of the machine module at `file`, which the script at
 * `importer` passes to `use()`, cannot run in a browser because the machine is
 * server-pinned. The module is imported in Node to read its capabilities; one
 * that cannot load there (it touches a browser global at the top level), and
 * a machine a factory produces, are let through unchecked.
 */
export async function assertRunsInBrowser(
  file: string,
  importer: string,
  runs: readonly string[],
  root?: string,
): Promise<void> {
  const names = runs.filter((r) => r !== FACTORY)
  if (names.length === 0) return
  let mod: Record<string, unknown>
  try {
    // Keyed by the file's mtime: Node caches a module by URL, and dev has to
    // see the machine as it is after an edit, not as it first loaded.
    const stamp = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0
    mod = (await import(`${pathToFileURL(file).href}?machine=${stamp}`)) as Record<string, unknown>
  } catch {
    return
  }
  const show = (p: string): string => (root ? relative(root, p).replace(/\\/g, '/') : p)
  for (const name of names) {
    const def = mod[name] as
      | { name?: unknown; capabilities?: { serverPinned?: boolean; reasons?: string[] } }
      | undefined
    if (!def?.capabilities?.serverPinned) continue
    const label = typeof def.name === 'string' ? `"${def.name}"` : `the ${name} export`
    throw new Error(
      `stator: ${show(importer)} passes ${label} from ${show(file)} to use(), so it runs in ` +
        `the browser, but it is server-pinned: it ${(def.capabilities.reasons ?? []).join('; ')}. ` +
        'Dispatch to it instead, or keep that work out of a machine an island runs.',
    )
  }
}

const SERVER_ENTRY = '@statorjs/stator/server'

let serverValues: Promise<Set<string>> | undefined

/**
 * The values the script at `importer` takes from `@statorjs/stator/server`.
 * That entry is server code, so any of them in a browser bundle is a mistake.
 * A name the entry does not export as a value is a type, and is not listed:
 * a bundler drops it.
 */
export async function serverImports(importer: string): Promise<string[]> {
  const { regions } = scriptRegions(importer)
  serverValues ??= import('../server/index.ts').then((m) => new Set(Object.keys(m)))
  const values = await serverValues
  const out = new Set<string>()
  for (const { sf } of regions) {
    for (const imp of importsIn(sf)) {
      if (imp.spec !== SERVER_ENTRY || imp.typeOnly) continue
      if (imp.kind !== 'import' && imp.kind !== 'export') {
        out.add('*')
        continue
      }
      if (imp.defaultName) out.add('default')
      if (imp.exportStar || imp.namespace) out.add('*')
      for (const n of imp.named) if (!n.typeOnly && values.has(n.imported)) out.add(n.imported)
    }
  }
  return [...out]
}

/** The message for a browser bundle reaching the server entry. */
export function serverImportError(
  importer: string,
  names: readonly string[],
  root?: string,
): string {
  const shown = root ? relative(root, importer).replace(/\\/g, '/') : importer
  const what =
    names.length === 0 || names.includes('*') ? 'it' : names.map((n) => `"${n}"`).join(', ')
  return (
    `stator: ${shown} is bundled for the browser and imports ${what} from ` +
    `"${SERVER_ENTRY}", which is server code. A machine is defined with defineMachine from ` +
    '"@statorjs/stator/machine", which runs anywhere.'
  )
}

/**
 * Every problem with how the island scripts in `files` use machine modules,
 * for `stator check`: a use the build cannot place, a server-pinned machine
 * passed to `use()`, and a server-only import from `@statorjs/stator/server`.
 * The same analysis the island bundler runs, without bundling.
 */
export async function islandMachineErrors(
  root: string,
  files: readonly string[],
  machinesDir: string,
): Promise<string[]> {
  const errors: string[] = []
  const inMachinesDir = (abs: string): boolean => inDir(machinesDir, abs)
  for (const file of files) {
    const { regions } = scriptRegions(file)
    if (regions.length === 0) continue
    const serverOnly = await serverImports(file)
    if (serverOnly.length > 0) errors.push(serverImportError(file, serverOnly, root))
    const specs = new Set<string>()
    for (const { sf } of regions) for (const imp of importsIn(sf)) specs.add(imp.spec)
    for (const spec of specs) {
      const machine = target(spec, file)
      if (!machine || !(inMachinesDir(machine) || isMachineModule(machine))) continue
      const use = machineImportUse(file, spec, { root })
      if (use?.kind === 'error') errors.push(`stator: ${use.message}`)
      if (use?.kind !== 'real') continue
      try {
        await assertRunsInBrowser(machine, file, use.runs, root)
      } catch (err) {
        errors.push((err as Error).message)
      }
    }
  }
  return errors
}
