/**
 * The compiled-shape contract: the interface between a compiled component and
 * the runtime it runs on. What compiled output imports from
 * `@statorjs/stator/template` and `/client`, the island protocol its client
 * entry speaks, the scope attribute format, and the prop-signature shape.
 *
 * `COMPILED_CONTRACT` moves only when that interface changes, never with the
 * package version, so a release that leaves the shape alone does not refuse
 * every library compiled before it. Source maps, the pragma itself and
 * anything else that does not reach the runtime are not part of it.
 *
 * `scripts/contract-fingerprint.json` records the surface each value stands
 * for, and `tests/contract-fingerprint.test.ts` fails when the compiled
 * surface moves without a bump. Bump this by one and run
 * `pnpm contract:refresh` in the same commit.
 */
export const COMPILED_CONTRACT = 1

/** The first line of every stamped compiled module. `compiler` is
 *  informational; consumers compare `contract` only. */
export function contractPragma(compiler: string): string {
  return `/* @stator contract=${COMPILED_CONTRACT} compiler=${compiler || 'unknown'} */`
}

const PRAGMA_RE = /^\/\* @stator contract=(\d+)(?: compiler=(\S+))? \*\//

/** The contract a compiled module was stamped with, or undefined when its
 *  first line carries no pragma (compiled before stamps existed). */
export function readContract(code: string): { contract: number; compiler?: string } | undefined {
  const m = PRAGMA_RE.exec(code)
  if (!m) return undefined
  return { contract: Number(m[1]), ...(m[2] ? { compiler: m[2] } : {}) }
}
