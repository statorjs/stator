import { readdir } from 'node:fs/promises'
import { resolve, relative, extname, basename, dirname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isStatorRoute,
  isStatorApiRoute,
  type RouteDefinition,
  type ApiRouteDefinition,
} from './routing.ts'
import type { ModuleLoader } from './discovery.ts'

const nativeLoader: ModuleLoader = (file) => import(/* @vite-ignore */ pathToFileURL(file).href)

/** HTTP methods a route file may export. GET goes through `defineRoute`
 *  (page rendering); the rest go through `defineApiRoute` (mutation/API
 *  handlers). */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface DiscoveredRoute {
  /** Hono-shaped URL pattern. Path params are `:name`. */
  urlPath: string
  /** Names of path parameters in the order they appear in `urlPath`.
   *  Empty for static routes. */
  paramNames: string[]
  filePath: string
  /** GET route (page render). At most one. */
  GET?: RouteDefinition
  /** API routes by method. */
  POST?: ApiRouteDefinition
  PUT?: ApiRouteDefinition
  PATCH?: ApiRouteDefinition
  DELETE?: ApiRouteDefinition
}

/**
 * Walk the routes directory recursively and build URL patterns from file
 * paths. Conventions:
 *
 *   - `routes/foo.ts`         → `/foo`
 *   - `routes/foo/index.ts`   → `/foo`
 *   - `routes/foo/[id].ts`    → `/foo/:id`  (path param `id`)
 *   - `routes/[a]/[b].ts`     → `/:a/:b`
 *
 * Files may export any combination of `GET`/`POST`/`PUT`/`PATCH`/`DELETE`.
 * GET is a `defineRoute` (page renderer); the others are `defineApiRoute`.
 *
 * Files that don't export anything route-shaped are silently skipped. With
 * recursive walking, the routes tree often contains utility files
 * (templates, helpers) that aren't routes, and throwing on them would
 * force separate trees.
 */
export async function discoverRoutes(
  dir: string,
  load: ModuleLoader = nativeLoader,
): Promise<DiscoveredRoute[]> {
  const absDir = resolve(dir)
  const files = await walkRouteFiles(absDir)
  const routes: DiscoveredRoute[] = []

  for (const filePath of files) {
    const mod = await load(filePath)

    // GET is a page route, POST/PUT/PATCH/DELETE are API routes.
    const get = isStatorRoute(mod.GET) ? (mod.GET as RouteDefinition) : undefined
    const post = isStatorApiRoute(mod.POST) ? (mod.POST as ApiRouteDefinition) : undefined
    const put = isStatorApiRoute(mod.PUT) ? (mod.PUT as ApiRouteDefinition) : undefined
    const patch = isStatorApiRoute(mod.PATCH) ? (mod.PATCH as ApiRouteDefinition) : undefined
    const del = isStatorApiRoute(mod.DELETE) ? (mod.DELETE as ApiRouteDefinition) : undefined

    if (!get && !post && !put && !patch && !del) continue

    // Catch the easy mistake: GET defined with `defineApiRoute`, or a
    // mutation method defined with `defineRoute`. Throw with a clear hint.
    if (mod.GET && !get) {
      throw new Error(
        `stator: ${filePath} exports GET but it is not a defineRoute. ` +
          `GET handlers must be created with defineRoute(); use defineApiRoute() for POST/PUT/PATCH/DELETE.`,
      )
    }
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      if (mod[m] && !isStatorApiRoute(mod[m])) {
        throw new Error(
          `stator: ${filePath} exports ${m} but it is not a defineApiRoute. ` +
            `${m} handlers must be created with defineApiRoute(); defineRoute() is GET-only.`,
        )
      }
    }

    const { urlPath, paramNames } = filePathToRoute(absDir, filePath)
    routes.push({ urlPath, paramNames, filePath, GET: get, POST: post, PUT: put, PATCH: patch, DELETE: del })
  }

  return sortRoutes(mergeByUrlPath(routes))
}

/**
 * Merge routes that resolve to the same URL pattern (e.g. `about.stator`
 * contributing GET and `about.ts` contributing POST). Same method on two files
 * for one URL is a hard error.
 */
function mergeByUrlPath(routes: DiscoveredRoute[]): DiscoveredRoute[] {
  const byPath = new Map<string, DiscoveredRoute>()
  for (const r of routes) {
    const existing = byPath.get(r.urlPath)
    if (!existing) {
      byPath.set(r.urlPath, r)
      continue
    }
    for (const m of HTTP_METHODS) {
      if (r[m] === undefined) continue
      if (existing[m] !== undefined) {
        throw new Error(
          `stator: two files define ${m} for "${r.urlPath}" ` +
            `(${existing.filePath} and ${r.filePath}). A URL may have at most one handler per method.`,
        )
      }
      ;(existing as unknown as Record<string, unknown>)[m] = r[m]
    }
  }
  return [...byPath.values()]
}

/**
 * Sort routes most-specific-first (Astro's model). At match time the first
 * matcher that matches wins, so order encodes priority:
 *   - routes without a rest/catch-all segment rank before those with one
 *   - per segment, left to right: static (0) > named param (1) > rest (2)
 *   - more segments before fewer
 *   - ties alphabetically by urlPath
 */
export function sortRoutes(routes: DiscoveredRoute[]): DiscoveredRoute[] {
  const kinds = (urlPath: string): number[] =>
    urlPath
      .split('/')
      .filter(Boolean)
      .map((seg) => (seg.startsWith('*') ? 2 : seg.startsWith(':') ? 1 : 0))

  return [...routes].sort((a, b) => {
    const ka = kinds(a.urlPath)
    const kb = kinds(b.urlPath)
    const aRest = ka.includes(2)
    const bRest = kb.includes(2)
    if (aRest !== bRest) return aRest ? 1 : -1 // no-rest first
    const len = Math.min(ka.length, kb.length)
    for (let i = 0; i < len; i++) {
      if (ka[i] !== kb[i]) return ka[i]! - kb[i]! // lower kind = more specific
    }
    if (ka.length !== kb.length) return kb.length - ka.length // more segments first
    return a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0
  })
}

async function walkRouteFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walkRouteFiles(full)))
      continue
    }
    if (!e.isFile()) continue
    const ext = extname(e.name)
    // `.stator` route pages compile (via the loader) to a module exporting GET;
    // `.ts`/`.js` carry API handlers (and merge with a same-named page).
    if (ext !== '.ts' && ext !== '.js' && ext !== '.stator') continue
    out.push(full)
  }
  return out
}

/**
 * Turn an absolute file path inside the routes dir into a `/foo/:bar` URL
 * pattern plus the list of param names extracted from `[brackets]`.
 */
export function filePathToRoute(
  absDir: string,
  filePath: string,
): { urlPath: string; paramNames: string[] } {
  const ext = extname(filePath)
  const rel = relative(absDir, filePath)
  const dirSegments = dirname(rel).split(sep).filter((s) => s && s !== '.')
  const fileBase = basename(rel, ext)
  const segments = fileBase === 'index' ? dirSegments : [...dirSegments, fileBase]

  if (segments.length === 0) return { urlPath: '/', paramNames: [] }

  const paramNames: string[] = []
  const urlSegments = segments.map((seg) => {
    // Rest / catch-all: `[...name]` → `*name` (matches zero or more segments).
    const rest = seg.match(/^\[\.\.\.(.+)\]$/)
    if (rest) {
      const name = rest[1]!
      paramNames.push(name)
      return `*${name}`
    }
    const m = seg.match(/^\[(.+)\]$/)
    if (m) {
      const name = m[1]!
      paramNames.push(name)
      return `:${name}`
    }
    return seg
  })

  return { urlPath: '/' + urlSegments.join('/'), paramNames }
}
