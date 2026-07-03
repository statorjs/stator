import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { StatorManifest } from './build.ts'

/**
 * Production `headExtras` for a built `dist/`: links `components.css` when the
 * build produced one, and injects each route's island `<script type="module">`
 * tags from `stator-manifest.json`. Pass the result to `createApp`:
 *
 *   const app = await createApp({ ..., headExtras: await loadProductionHead(dist) })
 *
 * Both artifacts are optional — a server-only app without styles gets an
 * empty hook.
 */
export async function loadProductionHead(distDir: string): Promise<(filePath: string) => string> {
  const dist = resolve(distDir)

  let cssTag = ''
  try {
    await stat(join(dist, 'static', 'components.css'))
    cssTag = '<link rel="stylesheet" href="/static/components.css">'
  } catch {
    // no scoped component styles
  }

  let routes: StatorManifest['routes'] = {}
  try {
    const manifest = JSON.parse(
      await readFile(join(dist, 'stator-manifest.json'), 'utf8'),
    ) as StatorManifest
    routes = manifest.routes ?? {}
  } catch {
    // no islands
  }

  return (filePath: string): string => {
    const rel = relative(dist, resolve(filePath)).replace(/\\/g, '/')
    const scripts = routes[rel] ?? []
    return [cssTag, ...scripts.map((url) => `<script type="module" src="${url}"></script>`)]
      .filter(Boolean)
      .join('\n')
  }
}
