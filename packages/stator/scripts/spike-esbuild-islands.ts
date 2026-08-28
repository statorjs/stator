/**
 * Spike 1 (Vite exit, spec `toolchain-adapter-seam-and-the-vite-exit`):
 * bundle a real multi-island example with esbuild `splitting: true` and
 * compare against the current Vite implementation of the same seam.
 *
 *   pnpm --filter @statorjs/stator exec tsx scripts/spike-esbuild-islands.ts
 *
 * Reports, per bundler: total/entry/chunk bytes (raw + gzip), chunk layout,
 * and whether the client runtime deduped into a shared chunk or duplicated
 * per island (counted via a distinctive runtime marker string).
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  bundleIslands,
  type IslandBundle,
  type IslandEntry,
  walkFiles,
} from '../src/build/islands.ts'
import { bundleIslandsEsbuild } from '../src/build/islands-esbuild.ts'
import { compile, regionResolverFor } from '../src/compiler/index.ts'

const APPS = [
  { name: 'weather', root: resolve(import.meta.dirname, '../../../examples/weather') },
  { name: 'store', root: resolve(import.meta.dirname, '../../../apps/store') },
]

// String literals the client runtime emits exactly once each — they survive
// minification, so counting them per emitted chunk detects duplication of the
// runtime across islands.
const RUNTIME_MARKERS = ['stator:patches-received', '__events']

async function islandEntries(root: string): Promise<IslandEntry[]> {
  const out: IslandEntry[] = []
  for (const dir of ['templates', 'routes']) {
    const files = await walkFiles(join(root, dir), (f) => f.endsWith('.stator')).catch(
      () => [] as string[],
    )
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const kind = dir === 'routes' ? ('route' as const) : ('component' as const)
      const result = compile(source, {
        id: file,
        kind,
        resolveRegions: regionResolverFor(file, source),
      })
      if (result.isClient) out.push({ rel: file.slice(root.length + 1).replace(/\\/g, '/'), file })
    }
  }
  return out
}

const bytes = (s: string | Uint8Array): number =>
  typeof s === 'string' ? Buffer.byteLength(s) : s.byteLength
const gzip = (s: string | Uint8Array): number =>
  gzipSync(typeof s === 'string' ? Buffer.from(s) : s).byteLength
const kb = (n: number): string => `${(n / 1024).toFixed(1)}kB`

function report(label: string, bundle: IslandBundle): void {
  const entries = new Set(Object.values(bundle.islandUrls).map((u) => u.split('/').pop()))
  let total = 0
  let totalGz = 0
  console.log(`\n  ${label}: ${bundle.assets.length} files`)
  for (const a of [...bundle.assets].sort((x, y) => x.fileName.localeCompare(y.fileName))) {
    const raw = bytes(a.source)
    const gz = gzip(a.source)
    total += raw
    totalGz += gz
    const kind = entries.has(a.fileName.split('/').pop())
      ? 'entry'
      : a.fileName.startsWith('chunks/')
        ? 'chunk'
        : 'asset'
    const markers =
      typeof a.source === 'string'
        ? RUNTIME_MARKERS.map((m) => (a.source as string).split(m).length - 1).join('/')
        : '-'
    console.log(
      `    ${kind.padEnd(5)} ${a.fileName.padEnd(46)} ${kb(raw).padStart(9)}  gz ${kb(gz).padStart(8)}  markers ${markers}`,
    )
  }
  console.log(`    TOTAL ${kb(total).padStart(58)}  gz ${kb(totalGz).padStart(8)}`)
}

for (const app of APPS) {
  const entries = await islandEntries(app.root)
  if (entries.length === 0) continue
  console.log(
    `\n== ${app.name}: ${entries.length} islands (${entries.map((e) => e.rel.split('/').pop()).join(', ')})`,
  )
  const common = { root: app.root, machinesDir: join(app.root, 'machines'), entries }
  let t = performance.now()
  const vite = await bundleIslands(common)
  const viteMs = performance.now() - t
  t = performance.now()
  const esb = await bundleIslandsEsbuild(common)
  const esbMs = performance.now() - t
  report('vite   ', vite)
  report('esbuild', esb)
  console.log(
    `\n  bundle time: vite ${viteMs.toFixed(0)}ms, esbuild ${esbMs.toFixed(0)}ms (single cold run, order-biased — indicative only)`,
  )

  // Seam-contract parity: islandUrls keys must match; the modules list drives
  // the dev watcher's rebundle decision, so diverging sets are a correctness
  // signal, not a style difference.
  const urlsOk =
    JSON.stringify(Object.keys(vite.islandUrls).sort()) ===
    JSON.stringify(Object.keys(esb.islandUrls).sort())
  const vMods = new Set(vite.modules)
  const eMods = new Set(esb.modules)
  const onlyVite = [...vMods].filter((m) => !eMods.has(m))
  const onlyEsb = [...eMods].filter((m) => !vMods.has(m))
  console.log(`\n  islandUrls keys match: ${urlsOk}`)
  console.log(`  modules: vite ${vMods.size}, esbuild ${eMods.size}`)
  if (onlyVite.length) console.log(`    only-vite:\n      ${onlyVite.join('\n      ')}`)
  if (onlyEsb.length) console.log(`    only-esbuild:\n      ${onlyEsb.join('\n      ')}`)
}
