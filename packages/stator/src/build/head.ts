import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { StatorManifest } from './build.ts'

/**
 * Production `headExtras` for a built `dist/`: links EACH ROUTE's own scoped-
 * CSS href (`manifest.routeCss` — only the components that route's import
 * graph actually reaches, not a global stylesheet shared by every page), and
 * injects that route's island `<script type="module">` tags. Pass the result
 * to `createApp`:
 *
 *   const { headExtras, buildId } = await loadProductionHead(dist)
 *   const app = await createApp({ ..., headExtras, buildId })
 *
 * Everything is optional — a server-only app without styles gets an empty hook,
 * and a build with no `buildId` in its manifest just skips the reload handshake.
 */
export async function loadProductionHead(distDir: string): Promise<{
  headExtras: (filePath: string) => string
  buildId?: string
  /** Machine file → code hash from the build manifest; pass to `createApp` as
   *  `machineHashes` so hydration compares against what was built. Absent on
   *  a dist built before hashes existed — `createApp` then hashes live. */
  machines?: Record<string, string>
  /** The config file the artifact carries, `null` when the app has none, and
   *  `undefined` when the manifest predates the field — which `stator start`
   *  reads as "rebuild", since it cannot otherwise tell a config-less app from
   *  a config that never made the trip. */
  config?: string | null
  /** The `@statorjs/stator` version that produced the artifact, if recorded. */
  statorVersion?: string
}> {
  const dist = resolve(distDir)

  let routes: StatorManifest['routes'] = {}
  let routeCss: StatorManifest['routeCss'] = {}
  let buildId: string | undefined
  let machines: Record<string, string> | undefined
  let config: string | null | undefined
  let statorVersion: string | undefined
  try {
    const manifest = JSON.parse(
      await readFile(join(dist, 'stator-manifest.json'), 'utf8'),
    ) as StatorManifest
    routes = manifest.routes ?? {}
    routeCss = manifest.routeCss ?? {}
    buildId = manifest.buildId
    machines = manifest.machines
    config = manifest.config
    statorVersion = manifest.statorVersion
  } catch {
    // no manifest
  }

  const headExtras = (filePath: string): string => {
    const rel = relative(dist, resolve(filePath)).replace(/\\/g, '/')
    const href = routeCss[rel]
    const cssTag = href ? `<link rel="stylesheet" href="${href}">` : ''
    const scripts = routes[rel] ?? []
    return [cssTag, ...scripts.map((url) => `<script type="module" src="${url}"></script>`)]
      .filter(Boolean)
      .join('\n')
  }
  return {
    headExtras,
    buildId,
    ...(machines ? { machines } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(statorVersion ? { statorVersion } : {}),
  }
}
