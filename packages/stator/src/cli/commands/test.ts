import { spawn } from 'node:child_process'
import type { CliContext } from '../run.ts'

/** `@statorjs/stator/register`, by absolute URL so it resolves whatever the
 *  runner's working directory. */
const REGISTER = new URL('../../register.js', import.meta.url).href

/**
 * The runner's environment: `NODE_OPTIONS` gains `--import` of Stator's
 * loader, kept alongside anything already there. Stator ships TypeScript,
 * and a runner hands `node_modules` to Node — so Stator, and every package
 * built on it (direct or transitive, hoisted or not), would otherwise reach
 * Node unloadable. Child processes and workers inherit it. `LOG_LEVEL`
 * defaults to `silent` unless the caller set one.
 */
export function testEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const flag = `--import ${REGISTER}`
  const current = env.NODE_OPTIONS?.trim() ?? ''
  return {
    ...env,
    NODE_OPTIONS: current.includes(flag) ? current : `${current} ${flag}`.trim(),
    // Tests are an environment: framework logging defaults to silent so a
    // suite that exercises failure paths (guarded 403s, recovery from bad
    // snapshots) doesn't narrate them over the runner's output. Exporting
    // LOG_LEVEL restores any level for debugging a failing test.
    LOG_LEVEL: env.LOG_LEVEL ?? 'silent',
  }
}

/** The preload every test file gets: silent logging, and happy-dom for
 *  files marked `// @env happy-dom` (see src/test-env.ts). */
const TEST_ENV = new URL('../../test-env.ts', import.meta.url).href

/** What `stator test` runs when given no file patterns: test files anywhere
 *  under the app (Node already skips node_modules). Node's own defaults would
 *  also run every file inside a `test/` directory, fixtures included. */
export const DEFAULT_PATTERNS = ['**/*.test.ts', '**/*.spec.ts']

/** The runner's arguments: the loader and the preload, Node's runner, a
 *  force-exit so a test that leaves a server or watcher open cannot hang the
 *  run, then the caller's flags and patterns (or the defaults when the
 *  caller named no files). */
export function testArgs(rest: string[]): string[] {
  const named = rest.some((a) => !a.startsWith('-'))
  return [
    '--import',
    REGISTER,
    '--import',
    TEST_ENV,
    '--test',
    '--test-force-exit',
    ...rest,
    ...(named ? [] : DEFAULT_PATTERNS),
  ]
}

/**
 * Run the test suite with Node's own runner (`node --test`). Assertions come
 * from `node:assert/strict`, spies and fake timers from `node:test`'s `mock`;
 * nothing to install. Extra arguments pass through: `stator test --watch`,
 * `stator test tests/cart.test.ts`.
 */
export async function run(ctx: CliContext): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, testArgs(ctx.rest), {
      stdio: 'inherit',
      cwd: ctx.root,
      env: testEnv(),
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`tests failed (exit ${code})`)),
    )
  })
}
