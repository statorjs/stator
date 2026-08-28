/**
 * Copy the Literata variable faces (latin subset) from the Fontsource package
 * into `static/fonts/` — the self-hosting step a bundler would otherwise hide.
 * Runs from `predev`/`prebuild`; the copied files are gitignored (the package
 * is the source of truth). `@font-face` rules live in `static/app.css`.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = dirname(createRequire(import.meta.url).resolve('@fontsource-variable/literata/package.json'))
const out = join(root, 'static', 'fonts')
mkdirSync(out, { recursive: true })
for (const file of ['literata-latin-wght-normal.woff2', 'literata-latin-wght-italic.woff2']) {
  copyFileSync(join(pkg, 'files', file), join(out, file))
}
