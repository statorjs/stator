import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../run.ts'

/**
 * Run the test suite. The runner is a deliberately swappable seam — today it
 * wraps the app's local Vitest; as the platform matures this becomes
 * `node --test` (with a `.stator` loader hook), invisibly to callers.
 */
export async function run(ctx: CliContext): Promise<void> {
  const bin = join(
    ctx.root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
  )
  if (!existsSync(bin)) {
    throw new Error(
      'vitest not found in node_modules — install it, or run your test script directly',
    )
  }
  const args = ctx.rest.length > 0 ? ctx.rest : ['run']
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', cwd: ctx.root })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`tests failed (exit ${code})`)),
    )
  })
}
