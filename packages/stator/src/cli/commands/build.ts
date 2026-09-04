import { resolve } from 'node:path'
import { buildApp } from '../../build/index.ts'
import { loadConfig } from '../config.ts'
import type { CliContext } from '../run.ts'
import { checkStack } from './check.ts'

/** Compile the app to `dist/` — but validate the whole stack FIRST, so a broken
 *  server file fails the build instead of shipping silently. */
export async function run(ctx: CliContext): Promise<void> {
  await checkStack(ctx.root)
  const config = await loadConfig(ctx.root)
  const result = await buildApp({
    root: ctx.root,
    outDir: resolve(ctx.root, 'dist'),
    include: config.build?.include,
    untracedImports: config.build?.untracedImports,
  })
  const { copySet } = result
  process.stdout.write(
    `stator build: ${result.compiled} components → ${result.outDir}` +
      `${result.islands ? ` (${result.islands} island${result.islands === 1 ? '' : 's'})` : ''}` +
      ` · ${result.machines} machine${result.machines === 1 ? '' : 's'} hashed in ${result.machineHashMs} ms\n`,
  )
  // What the module graph decided to copy. Printed because a copy set derived
  // from code should be visible, not inferred from what turns up in dist/.
  process.stdout.write(
    `  copied: ${copySet.dirs.join(', ')}` +
      `${copySet.files.length ? ` · ${copySet.files.length} root file${copySet.files.length === 1 ? '' : 's'} (${copySet.files.join(', ')})` : ''}` +
      ` · graph walked in ${copySet.ms} ms\n`,
  )
  // How the artifact declares its dependencies — and, for a workspace member,
  // that its transitives are not locked.
  const { deps } = result
  if (deps.kind === 'copied') {
    process.stdout.write(
      `  deps: ${deps.files.join(' + ')} copied · on the target run \`${deps.install}\`\n`,
    )
  } else if (deps.kind === 'generated') {
    const n = Object.keys(deps.pinned ?? {}).length
    process.stdout.write(
      `  deps: no lockfile beside package.json (workspace app) — generated a package.json pinning ${n} direct dependenc${n === 1 ? 'y' : 'ies'}\n` +
        `        on the target run \`${deps.install}\`; transitives are NOT locked, so prefer resolving at build time (\`pnpm deploy --prod\`, or build in the image)\n`,
    )
    if (deps.unpinned?.length) {
      process.stdout.write(
        `        warning: could not read an installed version for ${deps.unpinned.join(', ')} — used the declared range\n`,
      )
    }
  }
  if (copySet.unused.length > 0) {
    process.stdout.write(
      `  not copied: ${copySet.unused.join(', ')} — nothing in the app imports or opens them` +
        ` (add to \`build.include\` if they're read at runtime)\n`,
    )
  }
  if (copySet.untraced.length > 0) {
    // Only reachable with `untracedImports: 'warn'` — the default throws.
    process.stdout.write(
      `  warning: ${copySet.untraced.length} untraceable dynamic import${copySet.untraced.length === 1 ? '' : 's'}` +
        ` — dist may be missing what they load:\n${copySet.untraced
          .map((u) => `    ${u.file}:${u.line}  ${u.source}\n`)
          .join('')}`,
    )
  }
  if (copySet.external.length > 0) {
    process.stdout.write(
      `  warning: ${copySet.external.length} file${copySet.external.length === 1 ? '' : 's'} reached outside the app root` +
        ` — not copied, so dist is not self-contained:\n${copySet.external.map((f) => `    ${f}\n`).join('')}`,
    )
  }
  // Deploy awareness: which machines' sessions this build resets (see the
  // snapshot hydration policy — sessions never outlive the code that made them).
  if (result.resetMachines) {
    process.stdout.write(
      result.resetMachines.length
        ? `  machine code changed — sessions reset on deploy for: ${result.resetMachines.join(', ')}\n`
        : '  no machine code changed — sessions carry over\n',
    )
  }
}
