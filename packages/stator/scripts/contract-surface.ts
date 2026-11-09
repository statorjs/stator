import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '../src/compiler/index.ts'

/**
 * The runtime-facing surface of compiled output, read from a fixed set of
 * fixtures compiled by the current compiler: what `COMPILED_CONTRACT` stands
 * for. `contract-fingerprint.json` records one entry per contract, and
 * `tests/contract-fingerprint.test.ts` fails when the surface moves without a
 * bump, or the number moves without the surface.
 *
 * The surface is what a compiled component and the runtime it runs on have to
 * agree on, and nothing else: the `@statorjs/stator/*` names compiled code
 * imports, the markup markers the runtime reads (`data-s-<hash>`, `data-b`,
 * `data-ref`, slot comments), the base-class methods generated wiring calls,
 * the export forms, and the children-region shape between caller and callee.
 * An error message, an internal variable name or whitespace is not on it. It
 * is a tripwire over those features, not a proof: a change it cannot see (an
 * argument's meaning, say) still needs a deliberate bump.
 */

const FIXTURES = join(import.meta.dirname, 'contract-fixtures')
const FILES: Array<[string, 'route' | 'component']> = [
  ['templates/card.stator', 'component'],
  ['templates/count-stepper.stator', 'component'],
  ['routes/index.stator', 'route'],
]

export interface ContractSurface {
  /** Specifier → sorted imported names, across every compiled module. */
  imports: Record<string, string[]>
  /** Sorted, normalized structural markers. */
  markers: string[]
}

export interface ContractRecord extends ContractSurface {
  contract: number
  fingerprint: string
}

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*'(@statorjs\/stator[^']*)'/gm

/** Drop what is not part of the contract: the stamp and any inline map. */
const strip = (code: string): string =>
  code.replace(/^\/\* @stator [^\n]*\n/, '').replace(/\n?\/\/# sourceMappingURL=.*$/s, '')

function markersOf(code: string, out: Set<string>): void {
  for (const m of code.matchAll(/\bdata-[a-z0-9-]*[a-z0-9]/g)) {
    out.add(`attr:${m[0].replace(/^data-s-[0-9a-f]+$/, 'data-s-<hash>')}`)
  }
  for (const m of code.matchAll(/<!--([a-z]+)\d+-->/g)) out.add(`comment:<!--${m[1]}N-->`)
  for (const m of code.matchAll(/^export (default function|const \w+ = \w+)/gm)) {
    out.add(`export:${m[1]}`)
  }
  if (/\bprops\.children\?\.\w+/.test(code)) out.add('children:callee reads props.children.<name>')
  if (/\bchildren: \{ default:/.test(code))
    out.add('children:caller passes children.{ default, <name> }')
  for (const m of code.matchAll(/\b__inner\.(\w+)/g)) out.add(`shell:html result .${m[1]}`)
}

/** The surface of the fixtures as the current compiler emits them. */
export function contractSurface(): ContractSurface {
  const imports = new Map<string, Set<string>>()
  const markers = new Set<string>()
  for (const [file, kind] of FILES) {
    const source = readFileSync(join(FIXTURES, file), 'utf8')
    const r = compile(source, { id: file, kind })
    for (const code of [r.serverCode, r.clientCode].map(strip)) {
      for (const m of code.matchAll(IMPORT_RE)) {
        const names = imports.get(m[2]!) ?? new Set<string>()
        for (const n of m[1]!.split(',')) if (n.trim()) names.add(n.trim())
        imports.set(m[2]!, names)
      }
      markersOf(code, markers)
      // Base-class methods the generated wiring calls: `this.x(` in the
      // generated subclass, minus anything the author's script names.
      const impl = code.indexOf('class __')
      if (impl !== -1) {
        const authored = code.slice(0, impl)
        for (const m of code.slice(impl).matchAll(/\bthis\.(\w+)\(/g)) {
          if (!new RegExp(`\\b${m[1]}\\b`).test(authored)) markers.add(`element:this.${m[1]}()`)
        }
      }
    }
  }
  return {
    imports: Object.fromEntries(
      [...imports].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, n]) => [s, [...n].sort()]),
    ),
    markers: [...markers].sort(),
  }
}

export function fingerprintOf(surface: ContractSurface): string {
  return createHash('sha256').update(JSON.stringify(surface)).digest('hex').slice(0, 16)
}

/** One line per surface feature, for a readable diff. */
export function surfaceLines(surface: ContractSurface): string[] {
  return [
    ...Object.entries(surface.imports).flatMap(([s, names]) =>
      names.map((n) => `import ${n} from ${s}`),
    ),
    ...surface.markers,
  ]
}

export function surfaceDiff(from: ContractSurface, to: ContractSurface): string[] {
  const a = new Set(surfaceLines(from))
  const b = new Set(surfaceLines(to))
  return [
    ...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`),
    ...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`),
  ]
}

/**
 * The record after a refresh: unchanged when the surface and the number
 * agree with its last entry, one entry longer after a deliberate bump.
 * Refuses a moved surface without a bump, a bump without a moved surface,
 * and a bump by more than one.
 */
export function refreshRecord(
  history: ContractRecord[],
  contract: number,
  surface: ContractSurface,
): ContractRecord[] {
  const fingerprint = fingerprintOf(surface)
  const last = history.at(-1)
  const entry = { contract, fingerprint, ...surface }
  if (!last) return [entry]
  if (contract === last.contract) {
    if (fingerprint === last.fingerprint) return history
    throw new Error(
      `the compiled-shape contract changed, and COMPILED_CONTRACT is still ${contract}. ` +
        `Bump it in src/compiler/contract.ts, then refresh:\n${surfaceDiff(last, surface).join('\n')}`,
    )
  }
  if (contract !== last.contract + 1) {
    throw new Error(`COMPILED_CONTRACT moved from ${last.contract} to ${contract}: bump it by one.`)
  }
  if (fingerprint === last.fingerprint) {
    throw new Error(
      `COMPILED_CONTRACT moved to ${contract}, but the compiled-shape surface did not change. ` +
        `A bump refuses every library compiled for ${last.contract}: revert it.`,
    )
  }
  return [...history, entry]
}

export const RECORD_PATH = join(import.meta.dirname, 'contract-fingerprint.json')

export function readRecord(): ContractRecord[] {
  return JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as ContractRecord[]
}
