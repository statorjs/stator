import { readdir } from 'node:fs/promises'
import { resolve, extname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isStatorRoute, type RouteDefinition } from './routing.ts'

export interface DiscoveredRoute {
  urlPath: string
  filePath: string
  GET?: RouteDefinition
  POST?: RouteDefinition
}

export async function discoverRoutes(dir: string): Promise<DiscoveredRoute[]> {
  const absDir = resolve(dir)
  const entries = await readdir(absDir, { withFileTypes: true })
  const routes: DiscoveredRoute[] = []

  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = extname(e.name)
    if (ext !== '.ts' && ext !== '.js') continue
    const filePath = resolve(absDir, e.name)
    const mod = await import(pathToFileURL(filePath).href)
    const base = basename(e.name, ext)
    const urlPath = base === 'index' ? '/' : `/${base}`

    const route: DiscoveredRoute = { urlPath, filePath }
    if (isStatorRoute(mod.GET)) route.GET = mod.GET
    if (isStatorRoute(mod.POST)) route.POST = mod.POST

    if (!route.GET && !route.POST) {
      throw new Error(
        `stator: ${filePath} has no GET or POST export. ` +
          `Export named GET / POST handlers built with defineRoute().`,
      )
    }
    routes.push(route)
  }

  return routes
}
