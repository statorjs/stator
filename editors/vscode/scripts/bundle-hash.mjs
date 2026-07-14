// The extension's BEHAVIORAL fingerprint: a hash of exactly what changes
// what users experience — the compiled server + client bundles and the
// shipped static assets. Deliberately EXCLUDES version-stamped packaging
// (the .vsix manifest) and the bundled tsdk (a verbatim copy of
// node_modules/typescript). Run after `pnpm run build`.
//
// Proven properties: a version bump does NOT change this hash; two builds
// produce the same hash; a comment-only compiler change is minified away
// (no false alarm); a real behavioral change flips it. The PR gate builds
// this at base and at head and compares.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

const targets = [
  join(root, 'dist', 'server.cjs'),
  join(root, 'dist', 'extension.js'),
  ...filesUnder(join(root, 'syntaxes')),
  join(root, 'language-configuration.json'),
].sort()

const h = createHash('sha256')
for (const f of targets) {
  h.update(f.slice(root.length))
  h.update(readFileSync(f))
}
process.stdout.write(`${h.digest('hex')}\n`)
