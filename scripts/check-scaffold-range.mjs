// Guards the release invariant RELEASING.md states but nothing enforced:
// create-stator's STATOR_RANGE must be bumped when a framework minor ships,
// or `pnpm create stator` scaffolds a range that trails the announced
// release (missed for 1.5 and 1.6). Compares the range's floor against the
// framework's current major.minor. Run in CI.
import { existsSync, readFileSync } from 'node:fs'

// During a prerelease the range deliberately trails: it must point at a version
// that exists on npm, and `^2.10.0` is not satisfied by `2.10.0-next.0`. The
// invariant resumes at the final release, which is when the sync step advances
// the range again.
const preMode = existsSync(new URL('../.changeset/pre.json', import.meta.url))

const { version } = JSON.parse(
  readFileSync(new URL('../packages/stator/package.json', import.meta.url)),
)
const scaffold = readFileSync(
  new URL('../packages/create-stator/index.js', import.meta.url),
  'utf8',
)

const match = scaffold.match(/const STATOR_RANGE = '\^(\d+)\.(\d+)\.\d+'/)
if (!match) {
  console.error('create-stator/index.js: could not find the STATOR_RANGE const — did it move?')
  process.exit(1)
}

const [fwMajor, fwMinor] = version.split('.').map(Number)
const [rangeMajor, rangeMinor] = [Number(match[1]), Number(match[2])]

if (preMode && (rangeMajor < fwMajor || (rangeMajor === fwMajor && rangeMinor <= fwMinor))) {
  console.log(
    `scaffold range: prerelease ${version} — STATOR_RANGE ^${match[1]}.${match[2]} stays on the ` +
      'last stable line until the final ships.',
  )
  process.exit(0)
}

if (rangeMajor !== fwMajor || rangeMinor !== fwMinor) {
  console.error(
    `create-stator scaffolds @statorjs/stator ^${match[1]}.${match[2]}.x but the framework is ${version}.\n` +
      `Bump STATOR_RANGE in packages/create-stator/index.js (see RELEASING.md → Notes).`,
  )
  process.exit(1)
}
console.log(
  `scaffold range in sync: STATOR_RANGE ^${match[1]}.${match[2]} matches framework ${version}.`,
)
