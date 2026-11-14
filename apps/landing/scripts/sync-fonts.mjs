/**
 * Copy the variable faces (latin subset) from the Fontsource packages into
 * `static/fonts/`. Runs from `predev`/`prebuild`; the copies are gitignored.
 * `@font-face` rules live in `static/site.css`.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const out = join(root, 'static', 'fonts')
mkdirSync(out, { recursive: true })

const faces = [
  ['@fontsource-variable/space-grotesk', 'space-grotesk-latin-wght-normal.woff2'],
  ['@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'],
]
for (const [pkg, file] of faces) {
  const dir = dirname(require.resolve(`${pkg}/package.json`))
  copyFileSync(join(dir, 'files', file), join(out, file))
}
