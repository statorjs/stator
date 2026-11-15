// Guards the framework's committed compiled components (`image.stator.ts`,
// `picture.stator.ts`): rebuilds them and fails if the result differs from what
// is committed — a compiler change without a rebuild, or a version bump without
// a restamp. `version-packages` rebuilds them, so the Version PR carries the new
// stamp. Run in CI.
import { spawnSync } from 'node:child_process'

const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status

if (run('pnpm', ['--filter', '@statorjs/stator', 'build:components']) !== 0) process.exit(1)

const dir = 'packages/stator/src/components'
if (run('git', ['diff', '--exit-code', '--stat', '--', dir]) !== 0) {
  console.error(
    `\n${dir}: compiled components are stale — run \`pnpm --filter @statorjs/stator build:components\` and commit the result.`,
  )
  process.exit(1)
}
