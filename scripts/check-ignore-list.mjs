// Guards the changesets config invariant: EVERY private workspace package
// except the VS Code extension (stator-vscode) must be in `ignore`.
// Without this, a newly added private package (e.g. a new example) would be
// silently versioned by the changesets Version PR. Run in CI.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url)))
const ignore = new Set(config.ignore ?? [])

// `pnpm -r` over every workspace package's name + private flag.
const raw = execSync(
  'pnpm -r --reporter=silent exec node -e "const p=require(process.cwd()+\'/package.json\');console.log(JSON.stringify({n:p.name,priv:!!p.private}))"',
  { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname },
)
const pkgs = raw
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const EXEMPT = new Set(['stator-vscode']) // versioned on purpose (marketplace)
const missing = pkgs.filter((p) => p.priv && !EXEMPT.has(p.n) && !ignore.has(p.n)).map((p) => p.n)

if (missing.length > 0) {
  console.error(
    `changesets config: these private packages are NOT in \`ignore\` and would be versioned:\n  ${missing.join('\n  ')}\n` +
      `Add them to .changeset/config.json → ignore (or make them non-private if they publish).`,
  )
  process.exit(1)
}
console.log(
  `ignore-list complete: ${pkgs.filter((p) => p.priv).length} private packages, all accounted for.`,
)
