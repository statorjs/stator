import { resolve } from 'node:path'
import { buildApp } from '../../build/index.ts'
import type { CliContext } from '../run.ts'
import { checkStack } from './check.ts'

/** Compile the app to `dist/` — but validate the whole stack FIRST, so a broken
 *  server file fails the build instead of shipping silently. */
export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root)
  const result = await buildApp({ root: ctx.root, outDir: resolve(ctx.root, 'dist') })
  process.stdout.write(
    `stator build: ${result.compiled} components → ${result.outDir}` +
      `${result.islands ? ` (${result.islands} island${result.islands === 1 ? '' : 's'})` : ''}\n`,
  )
}
