// Renders scripts/og-image.html to static/og-image.png with a local Chromium.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../static/og-image.png')
execFileSync(process.env.CHROMIUM ?? 'chromium', [
  '--headless=new',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1200,630',
  `--screenshot=${out}`,
  pathToFileURL(join(here, 'og-image.html')).href,
])
console.log(`wrote ${out}`)
