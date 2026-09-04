// Sync create-stator's STATOR_RANGE to the framework's current major.minor.
// Runs inside `version-packages` (after `changeset version`), so the Version PR
// always ships a scaffold range that matches the release being cut. This is the
// invariant that scripts/check-scaffold-range.mjs enforces — maintained
// automatically here instead of by hand (it was missed for 1.5 and 1.6).
//
// Except during a prerelease. A scaffolded range has to point at something
// installable, and a caret range does NOT match a prerelease of the same
// version: `^2.10.0` is not satisfied by `2.10.0-next.0`. Advancing the range
// while only `2.10.0-next.N` exists would make `pnpm create stator` produce an
// app that cannot install at all. So in pre mode the range stays where it is —
// pointing at the last stable line — and catches up when the final ships.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const idxUrl = new URL('../packages/create-stator/index.js', import.meta.url)
const preMode = existsSync(new URL('../.changeset/pre.json', import.meta.url))

const { version } = JSON.parse(
  readFileSync(new URL('../packages/stator/package.json', import.meta.url)),
)

if (preMode) {
  console.log(
    `sync-scaffold-range: prerelease (${version}) — leaving STATOR_RANGE alone, ` +
      'a caret range cannot install a prerelease',
  )
  process.exit(0)
}

const [major, minor] = version.split('.')
const next = `^${major}.${minor}.0`

const src = readFileSync(idxUrl, 'utf8')
const re = /const STATOR_RANGE = '\^\d+\.\d+\.\d+'/
if (!re.test(src)) {
  console.error(
    'sync-scaffold-range: could not find the STATOR_RANGE const in create-stator/index.js — did it move?',
  )
  process.exit(1)
}

const updated = src.replace(re, `const STATOR_RANGE = '${next}'`)
if (updated === src) {
  console.log(`sync-scaffold-range: STATOR_RANGE already ${next} (framework ${version})`)
} else {
  writeFileSync(idxUrl, updated)
  console.log(`sync-scaffold-range: STATOR_RANGE → ${next} (framework ${version})`)
}
