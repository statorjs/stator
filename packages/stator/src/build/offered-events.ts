import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../compiler/index.ts'
import { isMachineModule } from './machines.ts'
import { isIslandShell, reachFrom } from './reachability.ts'

/**
 * The events a route offers the browser: every event type some template or
 * island the route can render sends, read from source.
 *
 * `/__events` accepts an event only when the page it names offers it. The list
 * is static on purpose. It does not ask what this session was shown, so a
 * button inside a `defer` arm, an inactive `when` arm or a row not rendered
 * yet all count, and a stale click is never refused. What it excludes is what
 * no UI sends: an effect's completion, a timer's event, another machine's
 * internals.
 *
 * Two shapes are read, both by their event `type` literal:
 *   - `machine.send({ type: 'ADD', … })` in a template or a fence (and in a
 *     hand-written `html` route);
 *   - `dispatch(Machine, { type: 'ADD', … })` in an island's `<script>` or a
 *     module it imports.
 * An event whose type is computed cannot be listed. Such a call makes the
 * route OPEN: every event its machines handle is accepted, as before, and
 * `stator check` reports where.
 *
 * The list is by event type, not by machine: a template's `cart` is a
 * variable, and tying it to a machine statically needs type information.
 */
export interface OfferedEvents {
  /** Event types the route's UI sends. */
  types: ReadonlySet<string>
  /** Sends whose type could not be read, as `file:line`. Non-empty ⇒ open. */
  open: readonly string[]
}

type Side = 'server' | 'client' | 'module'

interface Scan {
  types: string[]
  /** 1-based lines of unreadable sends. */
  open: number[]
}

/** The literal event types an argument can be, or undefined when computed. */
function eventTypes(arg: ts.Expression | undefined): string[] | undefined {
  if (!arg) return undefined
  if (ts.isStringLiteralLike(arg)) return [arg.text]
  if (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg)) return eventTypes(arg.expression)
  if (!ts.isObjectLiteralExpression(arg)) return undefined
  for (const p of arg.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const name = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : undefined
    if (name !== 'type') continue
    const literal = (e: ts.Expression): string[] | undefined => {
      if (ts.isStringLiteralLike(e)) return [e.text]
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return literal(e.expression)
      if (ts.isConditionalExpression(e)) {
        const a = literal(e.whenTrue)
        const b = literal(e.whenFalse)
        return a && b ? [...a, ...b] : undefined
      }
      return undefined
    }
    return literal(p.initializer)
  }
  return undefined
}

/**
 * Read one module's code.
 *   - `server`: a compiled `.stator` render module. Every `.send(…)` is a
 *     handler's (the compiler moved client-machine sends to the client half).
 *   - `client`: an island's client module. Only `dispatch(…)` crosses the
 *     wire; `this.qty.send(…)` drives a machine in the browser.
 *   - `module`: any other module. `.send({ type })` literals and `dispatch`
 *     calls count; a computed `.send(…)` counts only inside an `on(…)` call,
 *     since plain server code sends events of its own.
 */
export function scanOffered(code: string, file: string, side: Side): Scan {
  const sf = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const types = new Set<string>()
  const open: number[] = []
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const record = (
    call: ts.CallExpression,
    arg: ts.Expression | undefined,
    strict: boolean,
  ): void => {
    const found = eventTypes(arg)
    if (found) for (const t of found) types.add(t)
    else if (strict) open.push(line(call))
  }
  const visit = (n: ts.Node, inOn: boolean): void => {
    let nowInOn = inOn
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (ts.isIdentifier(callee) && callee.text === 'on') nowInOn = true
      if (ts.isIdentifier(callee) && callee.text === 'dispatch' && side !== 'server') {
        record(n, n.arguments[1], true)
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'send' &&
        side !== 'client'
      ) {
        record(n, n.arguments[0], side === 'server' || inOn)
      }
    }
    ts.forEachChild(n, (c) => visit(c, nowInOn))
  }
  visit(sf, false)
  return { types: [...types], open }
}

// Per file, re-read when its mtime moves: dev re-asks on every event.
const cache = new Map<string, { mtimeMs: number; scan: Scan }>()

function scanFile(file: string): Scan {
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat) return { types: [], open: [] }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.scan
  const text = readFileSync(file, 'utf8')
  let scan: Scan
  if (file.endsWith('.stator')) {
    // Read through the compiler: it is what decides which sends are a
    // server handler's and which drive a client machine.
    try {
      const out = compile(text, {
        id: file,
        kind: /[\\/]routes[\\/]/.test(file) ? 'route' : 'component',
      })
      const server = scanOffered(out.serverCode, `${file}.ts`, 'server')
      const client = out.clientCode
        ? scanOffered(out.clientCode, `${file}.client.ts`, 'client')
        : { types: [], open: [] }
      scan = {
        types: [...server.types, ...client.types],
        // Lines in compiled code are not the author's; point at the file.
        open: server.open.length + client.open.length > 0 ? [1] : [],
      }
    } catch {
      // A file that does not compile renders nothing; dev reports the error.
      scan = { types: [], open: [] }
    }
  } else if (/\.stator\.client\.[cm]?[jt]s$/.test(file)) {
    scan = scanOffered(text, file, 'client')
  } else if (isIslandShell(file) || /\.stator\.[cm]?[jt]s$/.test(file)) {
    scan = scanOffered(text, file, 'server')
    const client = file.replace(/\.ts$/, '.client.ts')
    if (existsSync(client)) {
      const more = scanFile(client)
      scan = { types: [...scan.types, ...more.types], open: [...scan.open, ...more.open] }
    }
  } else if (isMachineModule(file)) {
    // A machine renders nothing and sends nothing to itself over the wire.
    scan = { types: [], open: [] }
  } else {
    scan = scanOffered(text, file, 'module')
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, scan })
  return scan
}

/** What `routeFile` offers: the union over every module it can render. */
export async function routeOfferedEvents(
  routeFile: string,
  appRoot: string,
): Promise<OfferedEvents> {
  const root = resolve(appRoot)
  const reach = await reachFrom(routeFile, { appRoot: root })
  const modules = new Map(reach.modules)
  // A compiled island's script is a second module its shell never imports:
  // what the script imports can dispatch too.
  for (const mod of reach.modules.values()) {
    if (!isIslandShell(mod.file)) continue
    const client = await reachFrom(mod.file.replace(/\.ts$/, '.client.ts'), { appRoot: root })
    for (const [file, m] of client.modules) if (!modules.has(file)) modules.set(file, m)
  }
  const types = new Set<string>()
  const open: string[] = []
  for (const mod of modules.values()) {
    // The framework's own modules send events of every kind; none is UI.
    if (mod.pkg?.name === '@statorjs/stator') continue
    if (!/\.(stator|[cm]?[jt]sx?)$/.test(mod.file)) continue
    const scan = scanFile(mod.file)
    for (const t of scan.types) types.add(t)
    for (const l of scan.open) open.push(`${relative(root, mod.file).replace(/\\/g, '/')}:${l}`)
  }
  return { types, open }
}
