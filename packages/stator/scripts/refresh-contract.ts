import { existsSync, writeFileSync } from 'node:fs'
import { COMPILED_CONTRACT } from '../src/compiler/contract.ts'
import { contractSurface, RECORD_PATH, readRecord, refreshRecord } from './contract-surface.ts'

/**
 * `pnpm contract:refresh`: record the compiled-shape surface for the current
 * `COMPILED_CONTRACT`. Run it in the same commit as a bump. It refuses a
 * surface change without a bump, and a bump without a surface change.
 */
const history = existsSync(RECORD_PATH) ? readRecord() : []
try {
  const next = refreshRecord(history, COMPILED_CONTRACT, contractSurface())
  if (next === history) {
    process.stdout.write(`contract ${COMPILED_CONTRACT}: surface unchanged, nothing to record\n`)
  } else {
    writeFileSync(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`)
    process.stdout.write(
      `contract ${COMPILED_CONTRACT}: recorded fingerprint ${next.at(-1)!.fingerprint}\n`,
    )
  }
} catch (err) {
  process.stderr.write(`contract:refresh: ${(err as Error).message}\n`)
  process.exitCode = 1
}
